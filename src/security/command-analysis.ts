export interface CommandAnalysis {
  readonly normalized: string;
  readonly commands: readonly string[];
  readonly syntaxError?: string;
  readonly dynamic: boolean;
  readonly dangerous: boolean;
}

export type CommandShell = "powershell" | "sh";

export function analyzeCommand(command: string, shell: CommandShell): CommandAnalysis {
  const structure = splitExecutableCommands(command, shell);
  const dynamic =
    shell === "powershell"
      ? isDynamicPowerShell(command)
      : isDynamicSh(command);
  const dangerous =
    shell === "powershell"
      ? isDangerousPowerShell(command)
      : isDangerousSh(command);

  return {
    normalized: command.trim().replace(/\s+/gu, " "),
    commands: structure.commands,
    ...(!structure.valid ? { syntaxError: "Command contains an unterminated quote or escape" } : {}),
    dynamic,
    dangerous,
  };
}

function isDynamicPowerShell(command: string): boolean {
  return /(?:^|[;|]\s*)(?:Invoke-Expression|iex)\b[^;|\n]*\$/iu.test(command)
    || /(?:^|[;|]\s*)&\s*\$/u.test(command);
}

function isDynamicSh(command: string): boolean {
  return /(?:^|[;|&]\s*)(?:sh|bash|dash|zsh)\s+-c\s+["']?\$/u.test(command)
    || /(?:^|[;|&]\s*)eval\b[^;|\n]*\$/u.test(command)
    || /(?:^|[;|&]\s*)["']?\$[A-Za-z_][A-Za-z0-9_]*/u.test(command);
}

export function destroysWorkspaceRoot(command: string, shell: CommandShell): boolean {
  if (shell === "powershell") {
    return /(?:^|[;|&]\s*)Remove-Item\b(?=[^;|&\n]*(?:-Recurse|-r)\b)(?=[^;|&\n]*\s\.\s*$)/iu.test(command);
  }
  return /\brm\b(?=[^;&|\n]*-[a-z]*r)(?=[^;&|\n]*-[a-z]*f)(?=[^;&|\n]*\s\.\s*$)/iu.test(command);
}

function isDangerousPowerShell(command: string): boolean {
  const boundary = "(?:^|[;|&]\\s*)";
  return new RegExp(
    `${boundary}(?:Format-Volume|Clear-Disk|Initialize-Disk|diskpart|Stop-Computer|Restart-Computer)(?:\\s|$)`,
    "iu"
  ).test(command)
    || new RegExp(`${boundary}shutdown(?:\\.exe)?\\s+/(?:s|r)(?:\\s|$)`, "iu").test(command)
    || /(?:^|[;|&]\s*)Remove-Item\b(?=[^;|&\n]*(?:-Recurse|-r)\b)(?=[^;|&\n]*\s["']?(?:~|\$HOME)["']?\s*$)/iu.test(command)
    || /while\s*\(\s*\$true\s*\)[\s\S]*?Start-Process\b/iu.test(command)
    || /(?:Set-Content|Out-File)[\s\S]*?\\\\\.\\PhysicalDrive\d+/iu.test(command);
}

function isDangerousSh(command: string): boolean {
  const boundary = "(?:^|[;|&]\\s*)";
  if (new RegExp(
    `${boundary}(?:mkfs(?:\\.[a-z0-9_-]+)?|fdisk|sfdisk|parted|wipefs)(?:\\s|$)`,
    "iu"
  ).test(command)) return true;
  if (/\bdd\b(?=[^;&|\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|vd[a-z]|xvd[a-z])(?:\s|$))/iu.test(command)) {
    return true;
  }
  if (/\brm\b(?=[^;&|\n]*-[a-z]*r)(?=[^;&|\n]*-[a-z]*f)(?=[^;&|\n]*\s\/(?:\s|$))/iu.test(command)) {
    return true;
  }
  if (/\brm\b(?=[^;&|\n]*-[a-z]*r)(?=[^;&|\n]*-[a-z]*f)(?=[^;&|\n]*\s["']?(?:~|\$HOME)["']?\s*$)/iu.test(command)) {
    return true;
  }
  if (/\b(?:chmod|chown)\b(?=[^;&|\n]*(?:-R|--recursive))(?=[^;&|\n]*\s\/(?:\s|$))/iu.test(command)) {
    return true;
  }
  if (new RegExp(`${boundary}(?:shutdown|reboot|poweroff|halt)(?:\\s|$)`, "iu").test(command)) {
    return true;
  }
  if (new RegExp(`${boundary}systemctl\\s+(?:reboot|poweroff|halt)(?:\\s|$)`, "iu").test(command)) {
    return true;
  }
  return /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u.test(command);
}

function splitExecutableCommands(
  command: string,
  shell: CommandShell
): { readonly commands: string[]; readonly valid: boolean } {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (end: number): void => {
    const node = command.slice(start, end).trim().replace(/\s+/gu, " ");
    if (node) commands.push(node);
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if ((shell === "sh" && character === "\\") || (shell === "powershell" && character === "`")) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    const double = command.slice(index, index + 2);
    const boundaryLength = double === "&&" || double === "||" ? 2 : character === "|" || character === ";" ? 1 : 0;
    if (boundaryLength === 0) continue;
    push(index);
    index += boundaryLength - 1;
    start = index + 1;
  }
  push(command.length);
  return { commands, valid: quote === undefined && !escaped };
}
