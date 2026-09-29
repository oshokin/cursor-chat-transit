process.stdout.write('READY\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('GO')) {
    process.stdout.write('DONE\n');
    process.exit(0);
  }
});
