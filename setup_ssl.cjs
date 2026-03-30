const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  
  const commands = [
    'apt-get update',
    'apt-get install -y certbot python3-certbot-nginx',
    'certbot --nginx -d myaura.by -d www.myaura.by --non-interactive --agree-tos -m deploy@myaura.by --redirect'
  ];

  conn.exec(commands.join(' && '), (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      process.stdout.write('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      process.stderr.write('STDERR: ' + data);
    });
  });
}).connect({
  host: '91.149.179.76',
  port: 22,
  username: 'root',
  password: 'Happyaura2026$'
});
