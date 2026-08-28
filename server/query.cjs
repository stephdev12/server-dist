const { ConvexHttpClient } = require('convex/browser');
const client = new ConvexHttpClient(process.env.CONVEX_URL);
client.query('forms:listByAutomation', { automationId: 'jx70chw0800z52jm06ytq2vwyn87sx1p' }).then(console.log).catch(console.error);
