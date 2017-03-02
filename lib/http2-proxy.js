(function () {
    // TODO consider adding montage collections to dependency (map, weak map, ie 10 and 11)

    const url = require('url');
    const parseUrl = url.parse;
    const http2 = require('http2');
    const websocket = require('websocket-stream');
    const EventEmitter = require('events').EventEmitter;
    const util = require('util');
    const cache = {};
    const activeWSConnections = {};
    const proxyMap = {};  // host to proxy ws address
    const define = require('./object-utils').define;
    const xhrProto = XMLHttpRequest.prototype;

    function ConfEmitter() {
        this.activeConfigurationCnt = 0;
        EventEmitter.call(this);
    }

    util.inherits(ConfEmitter, EventEmitter);

    ConfEmitter.prototype.increment = function () {
        this.activeConfigurationCnt++;
    };

    ConfEmitter.prototype.decrement = function () {
        this.activeConfigurationCnt--;
        if (this.activeConfigurationCnt == 0) {
            this.emit('completed');
        }
    };

    ConfEmitter.prototype.configuring = function () {
        return this.activeConfigurationCnt > 0;
    };

    const configuring = new ConfEmitter();

    // re-use ws connections to same url
    function getActiveWSConnection(url) {
        if (!activeWSConnections[url] || !activeWSConnections[url].writable) {
            // TODO, maybe enable perMessageDeflate in production
            // console.log("Opening WS transport: " + url);
            activeWSConnections[url] = websocket(url, "http2", {perMessageDeflate: false});
        }
        return activeWSConnections[url];
    }

    function handlePush(pushRequest) {
        // console.log("Received push: " + pushRequest);
        var key = originHostname + ':' + originPort + '/' + pushRequest.url;
        cache[key] = {request: pushRequest};
        cache[key]['response'] = null;
        cache[key]['data'] = null;

        // set result of cache on response
        pushRequest.on('response', function (response) {
            cache[key]['response'] = response;

            response.on('data', function (data) {
                console.log("DPW to fix: got data!!");
                cache[key]['body'] = data.toString();
            });


            // remove from cache when stream is closed?
            // TODO consider removal from cache, when stream finishes
            // response.on('finish', function () {
            //     cache[key] = {};
            // });
        });

    }

    // open h2 pull channel
    function openH2StreamForPush(hostname, port, path, transport) {
        // console.log('Opening h2 channel for pushing: ' + originHostname + ':' + originPort + '/' +pullPath);
        var request = http2.raw.request({
            hostname: hostname,
            port: port,
            path: path,
            transport: function () {
                return transport;
            }
        }, function (response) {
            response.on('finish', function () {
                console.warn('h2 pull stream closed, perhaps we should reopen: ' + hostname + ' ' + port + ' ' + path);
                // TODO progressive back off??
                // probably on request.on('error');
                openH2StreamForPush(hostname, port, path, transport);
            });
        });
        // add to cache when receive pushRequest
        request.on('push', handlePush);
        request.end();
    }

    function resolvePort(u) {
        var parse = (u instanceof url.constructor) ? u : parseUrl(u);
        var port = parse.port;
        if (port == null) {
            var s = parse.scheme;
            if (s === "ws" || s === "http") {
                port = 80;
            } else {
                port = 443;
            }
        }
        return port;
    }

    function getOrigin(u) {
        u = (u instanceof url.constructor) ? u : parseUrl(u);
        return u.protocol + '//' + u.host + ':' + resolvePort(u) + '/';
    }

    // add config by json
    function addConfig(config) {
        config = JSON.parse(config);
        var proxyUrl = config.url;
        var proxyTransportUrl = config.options.transport;
        var proxyH2PushPath = config.options.h2PushPath;

        proxyUrl = parseUrl(proxyUrl);
        proxyMap[getOrigin(proxyUrl)] = proxyTransportUrl;

        if (proxyH2PushPath) {
            var wsTransport = getActiveWSConnection(proxyTransportUrl);
            openH2StreamForPush(proxyUrl.hostname, resolvePort(proxyUrl), proxyH2PushPath, wsTransport);
        }
    }

    // add config by url
    function addConfigByUrl(url) {
        var xhr = new XMLHttpRequest();
        xhr._open('GET', url);
        configuring.increment();
        xhr.addEventListener("readystatechange", function () {
            if (xhr.readyState === XMLHttpRequest.DONE) {
                var status = xhr.status;
                if (status !== 200) {
                    throw new InvalidStateError('Failed to load configuration ' + url + ', status code: ' + status);
                }
                addConfig(xhr.response);
                configuring.decrement();
            }
        }, true);
        xhr._send();
    }

    // add configs by an array of urls
    function addConfigs(urls) {
        if (urls instanceof Array) {
            var cntI = urls.length;
            for (var i = 0; i < cntI; i++) {
                addConfigByUrl(urls[i]);
            }
        } else {
            throw new SyntaxError('Invalid arg: ' + urls);
        }
    }

////////////////////////////////////////////////// XMLHttpRequest ////////////////////////////////////////////////////

    Object.defineProperty(XMLHttpRequest, 'proxy', {
        enumerable: true,
        configurable: false,
        value: addConfigs
    });

    define(xhrProto, "_open", XMLHttpRequest.prototype.open);

    const HTTP_METHODS = [
        'GET',
        'OPTIONS',
        'HEAD',
        'POST',
        'PUT',
        'DELETE',
        'TRACE',
        'CONNECT'
    ];

    define(xhrProto, 'open', function (method, url, async, username, password) {
        // https://xhr.spec.whatwg.org/#the-open%28%29-method
        method = method.toUpperCase();
        if (HTTP_METHODS.indexOf(method.toUpperCase()) < 0) {
            throw new SyntaxError("Invalid method: " + method);
        }
        // parse so we know it is valid
        var parseurl = parseUrl(url);

        if (async === 'undefined') {
            async = true;
        } else if (async == false) {
            throw new SyntaxError("Synchronous is not supported");
        }

        this.__method = method;
        this.__url = url;
        this.__async = async;
        this.__headers = {};
        if (parseurl.host && username && password) {
            this.__username = username;
            this.__password = password;
        }

        var self = this;

        if (self.onreadystatechange) {
            self.__orscDelegate = self.onreadystatechange;
            self.onreadystatechange = function () {
                var rs = self.readyState;
                if (self.__lastreadystate == 1 && rs == 1) {
                    // NOOP
                } else {
                    self.__lastreadystate = rs;
                    self.__orscDelegate();
                }
            };
        }

        this._changeState(XMLHttpRequest.OPENED);
    });

    define(xhrProto, "_setRequestHeader", XMLHttpRequest.prototype.setRequestHeader);

    const HTTP2_FORBIDDEN_HEADERS = ['accept-charset',
        'accept-encoding',
        'access-control-request-headers',
        'access-control-request-method',
        'connection',
        'content-length',
        'cookie',
        'cookie2',
        'date',
        'dnt',
        'expect',
        'host',
        'keep-alive',
        'origin',
        'referer',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'via'];

    define(xhrProto, 'setRequestHeader', function (name, value) {
        // https://xhr.spec.whatwg.org/#the-setrequestheader%28%29-method
        // We don't check state here because it is deferred
        if (this._state !== "opened") {
            throw new InvalidStateError("Can not setRequestHeader on unopened XHR");
        }
        var lcname = name.toLowerCase();
        if (HTTP2_FORBIDDEN_HEADERS.indexOf(lcname) > 0
            || (lcname.lastIndexOf('sec-', 0) === 0 && lcname.replace('sec-').indexOf(lcname) > 0)
            || (lcname.lastIndexOf('proxy-', 0) === 0 && lcname.replace('proxy-').indexOf(lcname) > 0)
        ) {
            throw new SyntaxError("Forbidden Header: " + name);
        }
        this.__headers[name] = value;
    });

    define(xhrProto, "_send", XMLHttpRequest.prototype.send);

    define(xhrProto, 'send', function (body) {
        var self = this;
        if (configuring.configuring()) {
            // console.log("Sending XHR via native stack");
            configuring.once('completed', function () {
                self.send(body);
            });
        } else {
            var destination = parseUrl(this.__url);
            var o = getOrigin(destination);
            var proxyTransportUrl = proxyMap[o];
            if (proxyTransportUrl) {

                var isCached = false;
                if (isCached) {
                    // TODO is cached
                    // var parseUrl = destination;
                    // var key = destination.hostname + ':' + destination.port + destination.path;
                    // console.log(key);
                    // var cachedResult = cache[key];
                    // if (!body && this.__method === "GET" && cachedResult) {
                    //
                    //     console.log("using cached response!!");
                    //
                    //     redefine(this, 'readyState', 1);
                    //     this.onreadystatechange();
                    //
                    //
                    //     redefine(this, 'readyState', 2);
                    //     // TODO proxy correct status
                    //     redefine(this, 'status', 200);
                    //     this.onreadystatechange();
                    //
                    //
                    //     // todo headers
                    //     redefine(this, 'readyState', 3);
                    //     this.onreadystatechange();
                    //
                    //
                    //     // todo listener for data
                    //     var body = cache[key]['body'];
                    //     redefine(this, 'response', body);
                    //     redefine(this, 'readyState', 4);
                    //     this.onreadystatechange();
                    // }


                } else {
                    //////// Proxy request
                    if (body) {
                        // https://xhr.spec.whatwg.org/#the-send%28%29-method
                        if (body instanceof HTMLElement) {
                            if (!self.__headers['Content-Encoding']) {
                                self.__headers['Content-Encoding'] = 'UTF-8';
                            }
                            if (!self.__headers['Content-Type']) {
                                self.__headers['Content-Type'] = 'text/html; charset=utf-8';
                            }
                        } else {
                            // only other option in spec is a String
                            if (!self.__headers['Content-Encoding']) {
                                self.__headers['Content-Encoding'] = 'UTF-8';
                            }
                        }
                    }
                    var request = http2.raw.request({
                        // protocol has already been matched by getting transport url
                        // protocol: destination.protocol,
                        hostname: destination.hostname,
                        port: destination.port,
                        method: self.__method,
                        path: destination.path,
                        headers: self.__headers,
                        // auth: self.__headers // TODO AUTH
                        // TODO, change transport to createConnection
                        transport: function () {
                            return getActiveWSConnection(proxyTransportUrl);
                        }
                        // TODO timeout if syncronization set
                        // timeout: self.__timeout
                    }, function (response) {
                        self._changeState(XMLHttpRequest.HEADERS_RECEIVED, response);
                        response.on('data', function () {
                            self._changeState(XMLHttpRequest.LOADING);
                        });
                        response.on('finish', function () {
                            self._changeState(XMLHttpRequest.DONE);
                        });
                    });

                    request.on('error', function (e) {
                        // TODO, handle error
                        // self._changeState('error');
                    });

                    // add to cache when receive pushRequest
                    request.on('push', handlePush);

                    if (body) {
                        request.end(body);
                    } else {
                        request.end();
                    }

                }
            } else {
                this._open(this.__method,
                    this.__url,
                    this.__async,
                    this.__username,
                    this.__password);
                // TODO set headers
                this._send(body);
            }

        }
    });

    define(xhrProto, '_state', 'unsent');

    define(xhrProto, '_changeState', function (s, args) {
        switch (s) {
            case XMLHttpRequest.UNSENT:
                this._state = s;
                define(this, 'readyState', 0);
                if (this.onreadystatechange) {
                    this.onreadystatechange();
                }
                break;
            case XMLHttpRequest.OPENED:
                this._state = s;
                define(this, 'readyState', 1);
                if (this.onreadystatechange) {
                    this.onreadystatechange();
                }
                break;
            case XMLHttpRequest.HEADERS_RECEIVED:
                this._state = s;
                // assert args == response TODO
                var statusCode = args.statusCode;
                define(this, 'status', statusCode);
                var statusMessage = http2.STATUS_CODES[statusCode];
                if (statusMessage) {
                    define(this, 'statusText', statusMessage);
                } else {
                    console.warn('Unknown STATUS CODE: ' + statusCode);
                }
                define(this, 'readyState', 2);
                if (this.onreadystatechange) {
                    this.onreadystatechange();
                }
                break;
            case XMLHttpRequest.LOADING:
                this._state = s;
                define(this, 'readyState', 3);
                if (this.onreadystatechange) {
                    this.onreadystatechange();
                }
                break;
            case XMLHttpRequest.DONE:
                this._state = s;
                define(this, 'readyState', 4);
                if (this.onreadystatechange) {
                    this.onreadystatechange();
                }
                break;
            default:
                throw new InvalidStateError("Unexpect XHR _changeState: " + s);
            // https://xhr.spec.whatwg.org/#suggested-names-for-events-using-the-progressevent-interface
            // case "loadstart":
            //     break;
            // case "progress":
            //     break;
            // case "error":
            //     break;
            // case "abort":
            //     break;
            // case "error":
            //     break;
            // case "timeout":
            //     break;
            // case "load":
            //     break;
            // case "loadend":
            //     break;
            // default:
            //     var msg = "Unexpect XHR _changeState: " + s;
            //     console.error(msg);
            //     throw new Error(msg);
        }
    });


    function InvalidStateError(message) {
        this.name = 'InvalidStateError';
        this.message = message;
        this.stack = (new Error()).stack;
    }

    InvalidStateError.prototype = new Error;

    function SyntaxError(message) {
        this.name = 'InvalidStateError';
        this.message = message;
        this.stack = (new Error()).stack;
    }

    SyntaxError.prototype = new Error;


}).call(this);