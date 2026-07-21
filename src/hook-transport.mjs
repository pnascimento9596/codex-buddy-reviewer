export function writeHookOutput(value, writable = process.stdout) {
  if (!value) return Promise.resolve(false);
  const payload = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    writable.write(payload, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  });
}

export function createHookOutputGuard(writable = process.stdout) {
  let attempted = false;
  return Object.freeze({
    get attempted() {
      return attempted;
    },
    async write(value) {
      if (!value) return false;
      if (attempted) throw new Error('hook stdout output was already attempted');
      // A failed write callback is ambiguous: the host may already have received
      // some or all bytes. Mark the channel consumed before invoking write so a
      // caller can never emit a second JSON object after that ambiguity.
      attempted = true;
      return writeHookOutput(value, writable);
    }
  });
}
