const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString('utf8')
}));
process.stderr.write('fixture stderr');
process.exitCode = 7;
