// Misc
var fs = require('fs'),
	path = require('path'),
	exec = require('child_process').exec,
	execSync = require('sync-exec'),
	_ = require('underscore');

// Express
var express = require('express'),
	app = express();

// Dropbox
var DropboxClient = require('dropbox'),
	consumerKey = process.env.DBOX_KEY,
	consumerSecret = process.env.DBOX_SECRET,
	dropboxClients = {};
	
// Serve static files from ./htdocs
app.use(express.static(__dirname + '/htdocs'));
app.use('/js/', express.static(__dirname + '/node_modules/requirejs'));
app.use('/js/CodeMirror/', express.static(__dirname + '/node_modules/codemirror'));
// We don't need the extended features right now.
app.use(require('body-parser').urlencoded({extended: false}));
app.use(require('cookie-parser')());

// Use underscore.js for templating.
var cache = {};
app.engine('html', function (path, options, callback) {
	var str;

	if (cache[path]) {
		try {
			str = cache[path](options);
		} catch (e) {
			return callback(e);
		}
		return callback(null, str);
	}

	fs.readFile(path, function (e, content) {
		if (e) return callback(e);
		str = content.toString();
		try {
			cache[path] = _.template(str);
			str = cache[path](options);
		} catch (e) {
			return callback(e);
		}
		return callback(null, str);
	});
});
app.set('views', __dirname + '/views');
app.set('view engine', 'html');

// Get config options
var config = require('./config.json'),
	versions = {};

// DB
var url = 'mongodb://localhost:27017/LilyPond';

require('mongodb').MongoClient.connect(url, function (err, mongo) {
	// Throwing error from an async callback is bad, but this is fatal so
	// who cares.
	if (err) throw err;

	var session = require('express-session'),
		MongoStore = require('connect-mongo')(session),
		sessionStore = new MongoStore({db: mongo}),
		dbConnect = require('./lib/db'),
		db = dbConnect(mongo);

	app.use(session({
		store: sessionStore,
		resave: false,
		saveUninitialized: true,
		secret: '3891jasl',
		cookie: {
			path: '/',
			httpOnly: true,
			maxAge: 2592000000
		}
	}));

	app.get('/dropbox_logout', function(req, res) {
		delete dropboxClients[req.session.uid];
		req.session.destroy(function(err) {
			res.redirect('/');
		});
	});

	app.get('/dropbox_login', function(req, res) {
		var dropbox = dropboxClients[req.sessionID] = new DropboxClient({
			consumerKey: consumerKey,
			consumerSecret: consumerSecret,
			sandbox: true
		});
		
		dropbox.getRequestToken(function(err, requestToken, requestTokenSecret) {
			if (err) console.log('error', err);
			else {
				res.redirect('https://www.dropbox.com/1/oauth/authorize?oauth_token=' + requestToken + '&oauth_callback=http://' + req.headers.host + '/get_dropbox_access');
			}
		});
	});
	
	app.get('/get_dropbox_access', function(req, res) {
		var dropbox = dropboxClients[req.sessionID];
		
		dropbox.getAccessToken(function(err, accessToken, accessTokenSecret, results) {
			delete dropboxClients[req.sessionID];
			
			req.session.uid = results.uid;
			req.session.accessToken = accessToken;
			req.session.accessTokenSecret = accessTokenSecret;
			
			dropboxClients[results.uid] = dropbox;

			dropbox.getAccountInfo(function(err, info) {
				req.session.accountInfo = info;
				res.redirect('/');
			});
		});
	})

	app.get('/dropbox_metadata', function(req, res) {
		var dropbox = dropboxClients[req.session.uid] || (dropboxClients[req.session.uid] = new DropboxClient({
			consumerKey: consumerKey,
			consumerSecret: consumerSecret,
			accessToken: req.session.accessToken,
			accessTokenSecret: req.session.accessTokenSecret,
			sandbox: true
		}));
		
		dropbox.getMetadata(req.query.path || '/', {}, function(err, response) {
			res.send(response);
		});
	});

	app.get('/dropbox_file', function(req, res) {
		var dropbox = dropboxClients[req.session.uid] || (dropboxClients[req.session.uid] = new DropboxClient({
			consumerKey: consumerKey,
			consumerSecret: consumerSecret,
			accessToken: req.session.accessToken,
			accessTokenSecret: req.session.accessTokenSecret,
			sandbox: true
		}));
		
		dropbox.getFile(req.query.path, {}, function(err, body, response) {
			res.send(body, response.statusCode);
		});
	});
	
	app.post('/dropbox_save', function(req, res) {
		var dropbox = dropboxClients[req.session.uid] || (dropboxClients[req.session.uid] = new DropboxClient({
			consumerKey: consumerKey,
			consumerSecret: consumerSecret,
			accessToken: req.session.accessToken,
			accessTokenSecret: req.session.accessTokenSecret,
			sandbox: true
		}));
		
		dropbox.putFile(req.body.path, req.body.contents, 'text/lilypond', function(err, response) {
			res.send(response, response.statusCode);
		});
	});

	// Routes
	app.post('/save', function(req, res) {
		var code = req.body.code,
			id = req.body.id || Math.random().toString(36).substring(2, 8),
			version = req.body.version || 'stable',
			tempSrc = __dirname + '/src/' + id + '.ly';
		
		db.scores.save({id: id, code: code, version: version}, function(err, revision) {
			res.send({id: id, revision: revision});
		});
		
		//db.log({action: 'save', ip: ipAddr(req), id: id, version: version});
	});

	app.post('/prepare_preview', function(req, res) {
		var code = req.body.code,
			id = req.body.id || Math.random().toString(36).substring(2, 8),
			version = req.body.version || 'stable',
			tempSrc = __dirname + '/render/' + id + '.ly';
	
		fs.writeFile(tempSrc, code, function(err) {
			if (err) throw err;
			var start = new Date().getTime();
			exec(config.bin[version] + ' --formats=pdf,png -o ' + __dirname + '/render/' + id + ' ' + tempSrc, function(err, stdout, stderr) {
				if (err) {
					res.send({
						error: stderr,
						id: id,
						pages: 0
					});

					//db.log({action: 'prepare preview', ip: ipAddr(req), id: id, version: version, error: err, duration: new Date().getTime() - start});
					return;
				}
				fs.stat(__dirname + '/render/' + id + '.png', function(err, stats) {
					if (!err && stats) {
						fs.rename(__dirname + '/render/' + id + '.png', __dirname + '/render/' + id + '-page1' + '.png', function (err) {
							if (err) {
								res.status(500).send('Internal server error: file rename failed');
								console.error(err);
								return;
							}
							res.send({
								output: stderr,
								id: id,
								pages: 1
							});

							//db.log({action: 'prepare preview', ip: ipAddr(req), id: id, version: version, pages: 1, duration: new Date().getTime() - start});
						})
					}
					else {
						function recurseStat(page) {
							fs.stat(__dirname + '/render/' + id + '-page' + page + '.png', function (err, stats) {
								if (!err) return recurseStat(++page);
								res.send({
									output: stderr,
									id: id,
									pages: page - 1
								});
							});
						}
						recurseStat(1);

						//db.log({action: 'prepare preview', ip: ipAddr(req), id: id, version: version, pages: pages - 1, duration: new Date().getTime() - start});
					}
				});
			});
		});
	});

	app.get('/preview', function(req, res) {
		var id = req.query.id,
			page = req.query.page || 1;
		
		res.sendFile(__dirname + '/render/' + id + '-page' + page + '.png');

		//db.log({action: 'preview', ip: ipAddr(req), id: id, page: page});
	});

	app.get('/downloadPDF', function(req, res) {
		var id = req.query.id;
		
		res.download(__dirname + '/render/' + id + '.pdf', 'score.pdf');

		//db.log({action: 'preview', ip: ipAddr(req), id: id});
	});
	
	app.get('/downloadMidi', function(req, res) {
		var id = req.query.id;
		
		res.download(__dirname + '/render/' + id + '.midi', 'score.midi');

		//db.log({action: 'preview', ip: ipAddr(req), id: id});
	});
	
	app.get('/:id?/:revision?', function(req, res, next) {
		var id = req.params.id,
			revision = req.params.revision || 1;
	
		db.scores.get({id: id || 'default', revision: revision}, function(err, score) {
			if (!score) return next();
			score.id = id;
			score.revision = revision;
			res.render('index.html', {score: JSON.stringify(score), accountInfo: req.session.accountInfo || 'null', versions: versions});

			//db.log({action: 'page view', ip: ipAddr(req), id: id, revision: revision});
		});
	});

	app.get('/install', function(req, res) {
		db.scores.save({id: 'default', code: '', version: '1'}, function(err, revision) {
			if (err) {
				console.error(err);
				return res.status(500).send('Something went wrong! Check CLI output.');
			}
			res.send('LilyBin successfully installed');
		});
	});

});

var bins = Object.keys(config.bin)
for (var i = 0; i < bins.length; i++) {
	var out = execSync(config.bin[bins[i]] + ' -v');
	if (out.status !== 0) {
		console.error(config.bin[bins[i]] + ' -v:');
		console.error(out);
		throw new Error('LilyPond installation broken');
	}
	versions[bins[i]] = out.stdout.match(/^GNU LilyPond (.*)$/m)[1];
}

var port;
app.listen(port = process.env.LISTEN_PORT || 3001);
console.log("Listening on port " + port + ".");

function ipAddr(req) {
	var ip = null;
	try {
		ip = req.headers['x-forwarded-for'];
	}
	catch ( error ) {
		ip = req.connection.remoteAddress;
	}
	return ip;
}
