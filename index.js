var express = require('express');
var app = express();
var deferred = require('deferred');
var najax = require('najax');
var _ = require('underscore-node');
var SG = require('ml-savitzky-golay');
var Sequelize = require('sequelize');
var CronJob = require('cron').CronJob;
var moment = require('moment');
require('dotenv').config() // load config vars from .env into process.env

var db_url = process.env.DATABASE_URL;

var currentTimezone = moment(new Date()).format('Z');
console.log(currentTimezone);
var sequelize = new Sequelize(process.env.DATABASE_URL, {
    timezone: currentTimezone
});
app.secretkey = process.env.SECRET_KEY;
var maxDataLength = 86400; //12;

// first define the model
var DataPoint = sequelize.define('datapoint', {
  variance: Sequelize.INTEGER,
  time: Sequelize.DATE,
  diff: Sequelize.BOOLEAN
});

var Stat = sequelize.define('daystats', {
    average: Sequelize.INTEGER,
    day: Sequelize.DATE
});

DataPoint.sync().then(function() {
    console.log('datapoints - table ready!');
});

Stat.sync().then(function() {
    console.log('daystats - table ready!');
});

// API Ends
var topStoriesAPI = "https://hacker-news.firebaseio.com/v0/topstories.json";
var itemAPI = "https://hacker-news.firebaseio.com/v0/item/{{itemId}}.json";
var algoliaFrontPageAPI = "http://hn.algolia.com/api/v1/search?tags=front_page";

var updateInterval = 60000;

var getClosestSmoothVariance = function(dps, i) {
    while (i > 1) {
        var current = dps[i];
        var prev = dps[i-1];
        
        if (!prev.diff && !current.diff) {
            var changeMagnitude = Math.abs(current.variance - prev.variance);
            changeMagnitude = changeMagnitude === 0 ? 0 : Math.log(changeMagnitude);
            return changeMagnitude;
        }
        
        i--;
    }
    
    return 0;
};

var smoothenData = function(dps) {
    if (! dps.length) {
        return [];
    }
    
    var varianceDps = [];
    for (var i=1; i<dps.length; i++) {
        var varianceDp = {                
            time: dps[i].time,
            diff: dps[i].diff
        };
        
        varianceDp.variance = getClosestSmoothVariance(dps, i);
        varianceDps.push(varianceDp);
    }
    
    var sharpSignals = varianceDps.map(function(dp) {
        return dp.variance;
    });
    
    var smoothSignals = SG(sharpSignals, 1, {derivative: 0});
    
    var varianceDps = varianceDps.map(function(dp, i) {
        dp.variance = smoothSignals[i];
        return dp;
    }).filter(function(dp) {
        return dp.variance;
    });
    
    return varianceDps;
};

var dow = {
    0: 'Sunday',
    1: 'Monday',
    2: 'Tuesday',
    3: 'Wednesday',
    4: 'Thursday',
    5: 'Friday',
    6: 'Saturday'
};

var getLastWeekActivity = function() {
    var promises = [];
    var dfd = deferred();
    var resp = {
        'Sunday': null,
        'Monday': null,
        'Tuesday': null,
        'Wednesday': null,
        'Thursday': null,
        'Friday': null,
        'Saturday': null
    };

    
    var today = new Date().setHours(0, 0, 0, 0);
    today = moment(today);
    var lastSaturday = today.clone().startOf('week').subtract(1, 'day');
    for (var i=6; i>=0; i--) {
        var day = lastSaturday.clone().subtract(i, 'days');
        var dateString = day.format('YYYY-MM-DD');
        var querySql = "SELECT * FROM datapoints where DATE(time) = DATE('<dateString>') ORDER BY time desc"
            .replace(/\<dateString\>/g, dateString);
        
        promises.push(sequelize.query(querySql, {model: DataPoint}))
    }
    
    deferred.apply(deferred, promises).then(function() {
        var results = arguments[0];
        var resp = {};
        
        _.each(results, function(dps) {
            var dps = smoothenData(dps);
            var avg = dps.map(function(dp) {
                return dp.variance
            }).reduce(function(prev, next) {
                return prev + next;
            }) / dps.length;
            var day = moment(dps[0].time).format('dddd');
            resp[day] = {average: avg};
        });
        dfd.resolve(resp);
    }).catch(function(){
        dfd.resolve();
    })
    return dfd.promise;
};

app.get('/', function(req, res) {
    res.sendFile('index.html', {
        root: __dirname + '/public'
    });
});

app.use('/static', express.static(process.env.PWD+'/public'));

app.get('/variance', function (req, res) {
  // stream past 24 hours HN activity data points;
  sequelize.query('SELECT * FROM datapoints WHERE time > current_date - 1 ORDER BY time desc', {model: DataPoint})
    .then(function(dps) {
        var varianceDps = smoothenData(dps);
        // return varianceDps;
        return res.json({datapoints: varianceDps});
        
    });
});

app.get('/lastweek', function(req, res) {
    getLastWeekActivity().then(function(weekactivity) {
        if (!weekactivity) {
            weekactivity = {lastWeekActivity: {}};
        };
        return res.json({lastWeekActivity: weekactivity});
    });
});

app.get('/reset/:secretkey', function(req, res) {
    // drops all tables. authenticate with a secret key.
    var secretkey = req.params.secretkey;
    if (secretkey === app.secretkey) {
        DataPoint.sync({force: true}).then(function() {
            Stat.sync({force: true}).then(function() {
                return res.json({'status': 'success'});
            });
        });
    } else {
        return res.json({'status': 'failure'});
    }
});

app.listen(process.env.PORT || 4000, '127.0.0.1', function() {
  console.log('app listening on port 4000!');
});
