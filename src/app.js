const YAML = require('yaml')
const _ = require('underscore')
const cmdArgs = require('command-line-args')
const express = require('express')
const crypto = require('crypto')
const app = express()
const http = require('http')
const https = require('https')
const bodyParser = require('body-parser')
//const io = require('socket.io')(server)
const request = require('request')
const rp = require('request-promise')
const events = require('events')
const randomstring = require('randomstring')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const os = require('os')
const path = require('path')
const md5 = require('md5')
const ssh = require('ssh2')
const PersistentObject = require('persistent-cache-object');
const eventEmitter = new events.EventEmitter()

const cmdOptions = [
	{ name: 'port', alias: 'p', type: Number},
	{ name: 'redis', type: String }
]


const options = cmdArgs(cmdOptions)
const serverPort = options.port || 8080
// index dbs to keep list of files on storages.
const nodes = new PersistentObject('./nodes.db')
const rnodes = {}
const results = {}
const protocols = new PersistentObject('./protocols.db')

// setup express http server
//const httpsServer = https.createServer(credentials, app)
const httpServer = http.createServer(app)
app.use(bodyParser.urlencoded({extended: true}))
app.use(bodyParser.json())
app.use(express.static('./'))
app.get('/', function(req, res,next) {
    res.sendFile(__dirname + '/index.html')
})

const api = '/api/v1'

function trim(s) {
	if (!s) return ''
	return s.replace(/^\s+|\s+$/g,'')
}

function encodeBase64(s) {
	return new Buffer(s).toString('base64')
}

function decodeBase64(d) {
	return new Buffer(d, 'base64').toString()
}

function generateToken(user, namespace) {
	return jwt.sign({
		user: user,
		namespace: namespace || "default",
		date: new Date().toISOString()
	}, privateKey, {algorithm: 'RS256'})
}

function isEmpty(arr) {
	return arr.length === 0 ? true : false
}

function checkToken(req, res, next) {
	if (req.user) {
		next()
		return
	}
	const token = req.headers['x-access-token']
	if (!token) {
		res.status(403).send()
		return
	}
	const preDecoded = jwt.decode(token)
	if (!preDecoded) {
		res.status(403).send()
	}
	const user = preDecoded.email || preDecoded.user
	if(!users[user]) {
		res.status(403).send()
	}

	const cert = users[user].decodedPublicKey
	if (!cert) {
		res.status(403).send()
	}

	jwt.verify(token, cert, {algorithms: ['RS256']}, (err, decoded) => {
		if (err) {
			console.log(err)
			res.status(403).send()
			return
		}
		req['user'] = decoded.email
		next()
	})
}

function checkAdminToken(req, res, next) {
	if (req.user) {
		next()
		return
	}
	const token = req.headers['x-access-token']
	if (!token) {
		res.status(403).send()
		return
	}
	jwt.verify(token, publicKey, {algorithms: ['RS256']}, (err, decoded) => {
		if (err) {
			next()
			return
		}
		if (!(decoded.user == 'admin')) {
			next()
			return
		}
		req['user'] = decoded.user
		next()
	})
}

// a dumb retry function
async function retry(fn, times, interval) {
	return new Promise((resolve, reject) => {
		let cnt = 0
		let i = setInterval(async function() {
			cnt = cnt + 1
			if (cnt > times) {
				console.log("Rejecting " + cnt)
				clearInterval(i)
				reject(false)
				return
			}
			try {
				await fn()
				clearInterval(i)
				resolve(true)
			} catch(err) {
				console.log(err.message)
			}
		}, interval)
	})
}

function isHiddenFile(filename) {
	if (!filename) return true
	return path.basename(filename).startsWith('.')
}

function sleep(ms) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve()
		}, ms)
	})
}

function sshCommand(node, cmd) {
	return new Promise((resolve, reject) => {
		const conn = new ssh()
		let stdout = ''
		let stderr = ''
		conn.on('error', err => {
			reject(err)
		})
		conn.on('ready', () => {
			//console.log('[' + node.host + '] connected')
			conn.exec(cmd, (err, stream) => {
				if (err) reject(err)
				stream.on('close', (code, signal) => {
					conn.end()
					resolve({
						stdout: stdout,
						stderr: stderr
					})
				}).on('data', data => {
					console.log("[" + node.host + "][" + cmd + "][stdout] " + trim(data.toString('utf-8')))
					stdout += data.toString('utf-8') + '\n'
				}).stderr.on('data', data => {
					console.log("[" + node.host + "][" + cmd + "][stderr] " + trim(data.toString('utf-8')))
					stderr += data.toString('utf-8')
				})
			})
		}).connect({
			host: node.host,
			port: node.port || 22,
			username: node.user,
			privateKey: require('fs').readFileSync(process.env.HOME + "/.ssh/id_rsa")
		})
	})
}

function sshReadDir(node, dir) {
	return new Promise((resolve, reject) => {
		const conn = new ssh()
		let stdout = ''
		let stderr = ''
		const id = node.host + ":" + dir
		conn.on('error', err => {
			reject(err)
		})
		conn.on('ready', () => {
			conn.sftp((err, sftp) => {
				if (err) reject(err)
				sftp.readdir(dir, (err, list) => {
					if (err) reject(err)
					conn.end()
					resolve({
						[[id]]:list
					})
				})
			})
		}).connect({
			host: node.host,
			port: node.port || 22,
			username: node.user,
			privateKey: require('fs').readFileSync(process.env.HOME + "/.ssh/id_rsa")
		})
	})
}

nodes.hosts.forEach(async h => {
	rnodes[h.host] = h
	Object.keys(nodes.capabilities).forEach(async k => {
		const cmd = nodes.capabilities[k]
		const result = await sshCommand(h, cmd)
		if (result.stdout) {
			h.capabilities[k] = true
		}
	})
})

// api urls
app.get(api + '/list', (req, res) => {
	const promises = []
	nodes.hosts.forEach(async h => {
		if (h.dirs) {
			promises.push(sshReadDir(h, h.dirs[0]))
		}
	})
	Promise.all(promises).then(values => {
		const reply = {}
		values.forEach(v => {
			Object.keys(v).forEach(k => {
				reply[k] = v[k]
			})
		})
		res.status(200).send(reply)
	})
})

app.get(api + '/hosts', (req, res) => {
	res.status(200).send(nodes)
})

app.post(api + '/connect/:id', (req, res) => {
	const id = req.params.id
	const body = req.body
	res.status(200).send()
})

app.get(api + '/status/:id', async (req, res) => {
	const id = req.params.id
	if (!id) {
		res.status(400).send()
		return
	}
	if (!results[id]) {
		res.status(404).send()
		return
	}
	res.status(200).send(results[id])
})

/* example copy input
 * [{
 * 	  "protocol": "udt",
 *    "src": {
 *       "host": "sne-dtn-03.vlan7.uvalight.net",
 *       "path": "/tmp/10M.dat"
 *     },
 *     "dst": {
 *       "host": "lisa.surfsara.nl",
 *       "path": "/tmp/10M.dat"
 *     }
 * },
 *  {
 * 	  "protocol": "http",
 *     "src": {
 *       "host": "sne-dtn-03.vlan7.uvalight.net",
 *       "path": "10M.dat"
 *     },
 *     "dst": {
 *       "host": "lisa.surfsara.nl",
 *       "path": "/tmp/10M.dat.http"
 *     }
 * }]
*/
app.post(api + '/copy', async (req, res) => {
	if (!Array.isArray(req.body)) {
		res.status(400).send()
		return
	}
	const id = randomstring.generate(8)
	const localResults = []
	results[id] = localResults
	// process array of file copy requests
	req.body.forEach(async copyReq => {
		console.log(copyReq)
		const protocol = protocols[copyReq.protocol]
		if (!protocol) {
			res.status(404).send()
			return
		}
		// prepare source node
		const srcNode = rnodes[copyReq.src.host]
		const srcPath = copyReq.src.path
		const srcPullCmd = 'singularity pull --name ' + protocol.name + '.img shub://' + protocol.src.image 
		const srcResult = await sshCommand(srcNode, srcPullCmd)

		let srcCmd = protocol.src.cmd
		if (srcNode.dirs) {
			const map = "run --bind "+ srcNode.dirs[0] + ":/data"
			srcCmd = protocol.src.cmd.replace('run', map)
			console.log("[CMD] " + srcCmd)
		}
		
		// start src server container N.B. the server might be blocking
		const srcAsyncCmd = sshCommand(srcNode, srcCmd)

		//console.log("sleeping...")
		//await sleep(5000)
		//console.log("continue...")
		
		// prepare destination node
		const dstNode = rnodes[copyReq.dst.host]
		const dstPath = copyReq.dst.path
		const dstPullCmd = 'singularity pull --name ' + protocol.name + '.img shub://' + protocol.dst.image 
		const dstResult = await sshCommand(dstNode, dstPullCmd)
	
		let dstBind = "run"
		if (dstNode.dirs) {
			dstBind = "run --bind "+ dstNode.dirs[0] + ":/data"
		}

		// copy file: pull file to dst from src 
		const dstRunCmd = protocol.dst.cmd.replace('##HOST##', srcNode.host)
										.replace('##RPATH##', copyReq.src.path)
										.replace('##LPATH##', copyReq.dst.path)
										.replace('run', dstBind)
		const copyResult = await sshCommand(dstNode, dstRunCmd)

		copyReq.status = copyResult
		localResults.push(copyReq)
		if (protocol.src.stop) {
			console.log("[SSH " + copyReq.src.host + "] stopping " + protocol.src.cmd)
			const srcStop = await sshCommand(srcNode, protocol.src.stop)
		}

		
	})
	res.status(200).send({ id:id })
})

//console.log("Starting secure server...")
//httpsServer.listen(options.port || 4343)
console.log("Starting http server on " + serverPort)
httpServer.listen(serverPort)
