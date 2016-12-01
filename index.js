"use strict";

var Package = require("./package.json");

var Upyun = require('upyun'),
	mime = require("mime"),
	uuid = require("uuid/v4"),
	fs = require("fs"),
	request = require("request"),
	path = require("path"),
	winston = module.parent.require("winston"),
	nconf = module.parent.require('nconf'),
	gm = require("gm"),
	im = gm.subClass({imageMagick: true}),
	meta = module.parent.require("./meta"),
	db = module.parent.require("./database");

var plugin = {};

var upyunConn = null;

var settings = {
	"operaterName": process.env.UPYUN_OPERATER_NAME,
	"operaterPassword": process.env.UPYUN_OPERATER_PASSWORD,
	"endpoint": process.env.UPYUN_ENDPOINT || "v0.api.upyun.com",
	"bucket": process.env.UPYUN_UPLOADS_BUCKET || undefined,
	"path": process.env.UPYUN_UPLOADS_PATH || undefined,
	"host": process.env.UPYUN_HOST,
};

function fetchSettings(callback) {
	db.getObjectFields(Package.name, Object.keys(settings), function (err, newSettings) {
		if (err) {
			winston.error(err.message);
			if (typeof callback === "function") {
				callback(err);
			}
			return;
		}

		if (newSettings.operaterName) {
			settings.operaterName = newSettings.operaterName;
		} else {
			settings.operaterName = process.env.UPYUN_OPERATER_NAME;
		}

		if (newSettings.operaterPassword) {
			settings.operaterPassword = newSettings.operaterPassword;
		} else {
			settings.operaterPassword = process.env.UPYUN_OPERATER_PASSWORD;
		}

		if (!newSettings.bucket) {
			settings.bucket = process.env.UPYUN_UPLOADS_BUCKET || "";
		} else {
			settings.bucket = newSettings.bucket;
		}

		if (!newSettings.path) {
			settings.path = process.env.UPYUN_UPLOADS_PATH || "";
		} else {
			settings.path = newSettings.path;
		}

		if (!newSettings.host) {
			settings.host = process.env.UPYUN_HOST;
		} else {
			settings.host = newSettings.host;
		}

		if (!newSettings.endpoint) {
			settings.endpoint = process.env.UPYUN_ENDPOINT || "v0.api.upyun.com";
		} else {
			settings.endpoint = newSettings.endpoint;
		}

		if (settings.path) {
			UpyunConn().makeDir(getUpyunDir(), function (err, result) {
				if (err) {
					winston.error(err.message);
				}
				if (typeof callback === "function") {
					callback(err);
				}
			});
		} else if (typeof callback === "function") {
			callback();
		}
	});
}

function UpyunConn() {
	if (!upyunConn) {
		upyunConn = new Upyun(settings.bucket,
			settings.operaterName,
			settings.operaterPassword,
			settings.endpoint,
			{
			    apiVersion: 'v2',
			    secret: ''
			});
	}

	return upyunConn;
}

function makeError(err) {
	if (err instanceof Error) {
		err.message = Package.name + " :: " + err.message;
	} else {
		err = new Error(Package.name + " :: " + err);
	}

	winston.error(err.message);
	return err;
}

plugin.activate = function () {
	fetchSettings();
};

plugin.deactivate = function () {
	upyunConn = null;
};

plugin.load = function (params, callback) {
	fetchSettings(function (err) {
		if (err) {
			return winston.error(err.message);
		}
		var adminRoute = "/admin/plugins/upyun-uploads";

		params.router.get(adminRoute, params.middleware.applyCSRF, params.middleware.admin.buildHeader, renderAdmin);
		params.router.get("/api" + adminRoute, params.middleware.applyCSRF, renderAdmin);

		params.router.post("/api" + adminRoute + "/upyunsettings", upyunSettings);
		params.router.post("/api" + adminRoute + "/credentials", credentials);

		callback();
	});
};

function renderAdmin(req, res) {
	// Regenerate csrf token
	var token = req.csrfToken();

	var forumPath = nconf.get('url');
	if(forumPath.split("").reverse()[0] !== "/" ){
		forumPath = forumPath + "/";
	}
	var data = {
		bucket: settings.bucket,
		path: settings.path,
		host: settings.host,
		forumPath: forumPath,
		endpoint: settings.endpoint,
		operaterName: settings.operaterName,
		operaterPassword: settings.operaterPassword,
		csrf: token
	};

	res.render("admin/plugins/upyun-uploads", data);
}

function upyunSettings(req, res, next) {
	var data = req.body;
	var newSettings = {
		bucket: data.bucket || "",
		host: data.host || "",
		path: data.path || "",
		endpoint: data.endpoint || ""
	};

	saveSettings(newSettings, res, next);
}

function credentials(req, res, next) {
	var data = req.body;
	var newSettings = {
		operaterName: data.operaterName || "",
		operaterPassword: data.operaterPassword || ""
	};

	saveSettings(newSettings, res, next);
}

function saveSettings(settings, res, next) {
	db.setObject(Package.name, settings, function (err) {
		if (err) {
			return next(makeError(err));
		}

		fetchSettings();
		res.json("Saved!");
	});
}

plugin.uploadImage = function (data, callback) {
	var image = data.image;

	if (!image) {
		winston.error("invalid image" );
		return callback(new Error("invalid image"));
	}

	//check filesize vs. settings
	if (image.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	var type = image.url ? "url" : "file";
	var allowedMimeTypes = ['image/png', 'image/jpeg', 'image/gif'];

	if (type === "file") {
		if (!image.path) {
			return callback(new Error("invalid image path"));
		}

		if (allowedMimeTypes.indexOf(mime.lookup(image.path)) === -1) {
			return callback(new Error("invalid mime type"));
		}

		fs.readFile(image.path, function (err, buffer) {
			uploadToUpyun(image.name, err, buffer, callback);
		});
	}
	else {   //River: what is this about? need test.
		if (allowedMimeTypes.indexOf(mime.lookup(image.url)) === -1) {
			return callback(new Error("invalid mime type"));
		}
		var filename = image.url.split("/").pop();

		var imageDimension = parseInt(meta.config.profileImageDimension, 10) || 128;

		// Resize image.
		im(request(image.url), filename)
			.resize(imageDimension + "^", imageDimension + "^")
			.stream(function (err, stdout, stderr) {
				if (err) {
					return callback(makeError(err));
				}

				// This is sort of a hack - We"re going to stream the gm output to a buffer and then upload.
				// See https://github.com/aws/aws-sdk-js/issues/94
				var buf = new Buffer(0);
				stdout.on("data", function (d) {
					buf = Buffer.concat([buf, d]);
				});
				stdout.on("end", function () {
					uploadToUpyun(filename, null, buf, callback);
				});
			});
	}
};

plugin.uploadFile = function (data, callback) {
	var file = data.file;

	if (!file) {
		return callback(new Error("invalid file"));
	}

	if (!file.path) {
		return callback(new Error("invalid file path"));
	}

	//check filesize vs. settings
	if (file.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error("error:file-too-big, " + meta.config.maximumFileSize );
		return callback(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
	}

	fs.readFile(file.path, function (err, buffer) {
		uploadToUpyun(file.name, err, buffer, callback);
	});
};

function getUpyunDir() {
	var remotePath = '';
	if (settings.path && 0 < settings.path.length) {
		remotePath = settings.path;

		if (!remotePath.match(/^\//)) {
			// Add start slash
			remotePath = "/" + remotePath;
		}
		// remove trailing slash
		remotePath = remotePath.replace(/\/$/, '');

	}
	return remotePath;
}


function getUpyunHost() {
	var host = 'http://'+settings.bucket+'.b0.upaiyun.com';
	if (settings.host) {
		// must start with http://
		if (!settings.host.match(/^http/)) {
			host = 'http://' + settings.host;
		} else {
			host = settings.host;
		}
	}
	return host;
}

function uploadToUpyun(filename, err, buffer, callback) {
	if (err) {
		return callback(makeError(err));
	}

	var remotePath = getUpyunDir() + '/';

	remotePath += uuid() + path.extname(filename);

	UpyunConn().putFile(remotePath, buffer, null, true, null, function(err, result) {
		if (err) {
			return callback(makeError(err));
		}
		if (result.statusCode !== 200) {
			return callback(makeError(result.data));
		}
		var host = getUpyunHost();
		var remoteHref = host + remotePath;
		callback(null, {
			name: filename,
			url: remoteHref
		});
	});
}

var admin = plugin.admin = {};

admin.menu = function (custom_header, callback) {
	custom_header.plugins.push({
		"route": "/plugins/upyun-uploads",
		"icon": "fa-envelope-o",
		"name": "Upyun Uploads"
	});

	callback(null, custom_header);
};

module.exports = plugin;
