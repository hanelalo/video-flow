// Host-owned bridge. No arbitrary paths or commands are accepted by the broker.
const [operation = 'check', start = '0', duration = '3'] = process.argv.slice(2);
if (!['check', 'frames', 'preview'].includes(operation)) throw new Error('Use check, frames, or preview.');
const response = await fetch(process.env.VIDEO_FLOW_BROKER + '/tools', {
  method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + process.env.VIDEO_FLOW_PROJECT_TOKEN},
  body: JSON.stringify({operation, start: Number(start), duration: Number(duration)})
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok || !result.ok) process.exitCode = 1;
