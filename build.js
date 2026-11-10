const fs=require('fs');
const qr=fs.readFileSync('node_modules/qrcode-generator/qrcode.js','utf8');
const mq=fs.readFileSync('node_modules/mqtt/dist/mqtt.min.js','utf8');
for(const s of [qr,mq]) if(/<\/script/i.test(s)) throw new Error('script close inside lib');
let h=fs.readFileSync('src/template.html','utf8');
h=h.replace('/*__QR__*/',()=>qr).replace('/*__MQTT__*/',()=>mq);
fs.writeFileSync('index.html',h);console.log('built',h.length);
