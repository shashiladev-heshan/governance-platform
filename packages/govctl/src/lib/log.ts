const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const CSI = String.fromCharCode(27) + '[';

function paint(code: string, text: string): string {
  return useColor ? `${CSI}${code}m${text}${CSI}0m` : text;
}

export const color = {
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  blue: (t: string) => paint('34', t),
  dim: (t: string) => paint('2', t),
  bold: (t: string) => paint('1', t),
};

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(`${color.green('✔')} ${msg}`),
  warn: (msg: string) => console.log(`${color.yellow('!')} ${msg}`),
  fail: (msg: string) => console.error(`${color.red('✘')} ${msg}`),
  step: (msg: string) => console.log(`${color.dim('›')} ${msg}`),
  blank: () => console.log(''),
};
