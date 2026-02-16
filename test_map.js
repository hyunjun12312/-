const t0 = Date.now();
const {generateEarthMap} = require('./worldmap');
const m = generateEarthMap(800, 400);
let land = 0;
for (let i = 0; i < m.length; i++) if (m[i] > 0) land++;
console.log('Land:', land, '/', m.length, '=', (100*land/m.length).toFixed(1) + '%');
console.log('Time:', Date.now() - t0, 'ms');
