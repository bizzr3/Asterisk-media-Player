'use strict';

require('./config');
var mailFactory = require('./app/services/email');
var logger = require('./app/utils/logger');
var queue = require('./app/utils/queue');
var AST_TAG = '[ASTERISK]';
//var CronJob = require('cron').CronJob;
var mysql = require('mysql');

var ami = new require('asterisk-manager')(
    global.asteriskConnection.port,
    !global.devMode ? global.asteriskConnection.ip_address
    : global.asteriskConnection.debug_ip_address,
    global.asteriskConnection.username,
    global.asteriskConnection.password, true);


ami.keepConnected();

var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);

app.use(express.static('public'));

// Routes:
app.get('/', function (req, res) {
    res.sendFile(__dirname + '/resources/views/index.html');
});

app.get('/out', function (req, res) {
    res.sendFile(__dirname + '/resources/views/outbounds.html');
});

//Start
http.listen(global.http_port, function () {
    console.log('listening on *:' + global.http_port);
});

var peerListTemp = [];
ami.on('peerlistcomplete', function (status) {
    global.peers = peerListTemp;
    peerListTemp = [];
    io.emit('peer.statusChanged', global.peers);
});

ami.on('dial', function(dial) {
    if (/Begin|End/.test(dial.subevent)) {
        io.emit('peer.statusChanged', dial);
    }
});

ami.on('peerentry', function (peersStatus) {
    peerListTemp.push(peersStatus);
});


ami.on('peerstatus', function (peersStatus) {
    //console.log(peersStatus);
});

ami.on('queueparams', function (queueparams) {
    try {
        io.emit('queue.callers', queueparams.calls);
        io.emit('queue.servicelevelperf', queueparams.servicelevelperf);
    } catch(error) {
        logger.log(AST_TAG, error.stack(), 'fatal');
    }
    queue.updateQueuePerformace(queueparams.servicelevelperf);
});

ami.on('queueentry', function (queueentery) {
    try{
        io.emit('queue.income', {cid: queueentery.calleridnum, agent: queueentery.connectedlinenum});
    } catch(error) {
        logger.log(AST_TAG, error.stack(), 'fatal');
    }
});

ami.on('queuemember', function (agent) {
    queue.updateAgentsList(agent);
    try{
        io.emit('queue.members', agent);
    } catch(error) {
        logger.log(AST_TAG, error.stack(), 'fatal');
    }
});

ami.on('connect', function () {
    logger.log(AST_TAG, 'Connection to asterisk (' + ami.options.host + ') has been established.');
});

process.on('uncaughtException', function (error) {
    logger.log('[FAILURE]', error.stack, 'fatal');
});

io.sockets.on('connection', function(socket) {
    socket.on('report.send', function() {
        mailFactory.sendMetricEmail();
        io.emit('report.sent',JSON.stringify({status: 200, message: 'Report sent via email.'}));
    });

    socket.on('peers.getList', function() {
        var databaseConnection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'asteriskuser',
            password: 'amp109',
            database: 'asterisk'
        });

        databaseConnection.connect(function (err) {
            if (err) return;

            databaseConnection.query("SELECT * FROM users", function (error, users) {
                io.emit('peers.list', users);
            });
        });
    });
});

var cdrDatabaseConnection = mysql.createConnection({
    host: '127.0.0.1',
    user: 'asteriskuser',
    password: 'amp109',
    database: 'asteriskcdrdb'
});

cdrDatabaseConnection.connect(function (err) {
    if (err) console.log(err.stack);
});

var checkQueueStatus = function () {
    ami.action({
        'action': 'queuestatus',
        'channel': 'from-internal',
        'priority': 1
    });

    ami.action({
        'action': 'sippeers',
        'priority': 1
    });

    cdrDatabaseConnection.query("select * from cdr WHERE calldate >= CURDATE()  AND (dcontext = 'from-internal') order by billsec DESC;", function (error, totalstats) {
        if(error) console.log(error.stack);
        io.emit('peers.totalStats', totalstats);
    });

    setTimeout(checkQueueStatus, global.eventSendInterval);
};

checkQueueStatus();
