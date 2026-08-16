const [major] = process.versions.node.split('.').map(Number)
if (!major || major < 22) throw new Error('Node.js 22 or newer is required')
console.log(`Node.js ${process.versions.node} is supported.`)
