// Quoting for the few places that must go through cmd.exe on Windows (`daml`
// is a .cmd shim there, which Node will only start with shell:true).
//
// Inside double quotes cmd.exe treats & | < > ^ ( ) as plain text. What it
// still interprets is " (ends the quote), % (variable expansion), ! (delayed
// expansion) and line breaks. Those can't be escaped reliably, so any argument
// containing them is refused instead of being passed to the shell.

const UNSAFE = /["%!\r\n]/;

/** One argument, always double-quoted, safe to place in a cmd.exe line. */
export function winQuote(arg: string): string {
  if (UNSAFE.test(arg))
    throw new Error(
      `refusing to pass ${JSON.stringify(arg)} to cmd.exe: it contains " % ! or a line break. Rename the file or folder.`,
    );
  // A trailing backslash would escape the closing quote for the program's own
  // argument parser, so double it.
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/** A full cmd.exe command line from a program and its arguments. */
export function winCommandLine(program: string, args: string[]): string {
  return [program, ...args].map(winQuote).join(" ");
}
