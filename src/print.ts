/**
 * Write to stdout and wait until it is flushed. The CLI calls `process.exit`
 * right after this returns, which drops whatever a pipe has not taken yet:
 * `console.log` of a long listing was cut off at 64 KiB when piped into another
 * tool. (`Bun.write(Bun.stdout, …)` is no fix: on a pipe that takes a partial
 * write it starts over from the first byte, repeating the first 64 KiB.)
 */
export function print(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (err) => (err ? reject(err) : resolve()));
  });
}
