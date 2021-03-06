/* eslint require-atomic-updates: 0 */
'use strict';

const got = require('got');
const jwt = require('jsonwebtoken');
const { DateTime } = require('luxon');

module.exports = async (req, res) => {

  // Check method and set CORS
  switch (req.method) {
  case 'POST':
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ALLOW_ORIGIN);
    break;
  case 'OPTIONS':
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '3600');
    res.statusCode = 204;
    res.end();
    return;
  default:
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const token = req.query.token;
  if (!token) {
    res.statusCode = 401;
    res.end('Token missing');
    return;
  }

  let service = '';
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    service = decoded.sub;
  } catch(err) {
    res.statusCode = 401;
    res.end(`Invalid token: ${err}`);
    return;
  }

  // Read input
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });

  // Parse input
  const data = await new Promise(resolve => {
    req.on('end', () => {
      resolve(JSON.parse(body));
    });
  });

  let event = {};
  switch (service) {
  case 'apex':
    event = exports.apexEvent(data);
    break;
  case 'stackdriver':
    event = exports.stackdriverEvent(data);
    break;
  default:
    res.statusCode = 400;
    res.end('Unknown service');
    return;
  }

  // Send
  try {
    await exports.discordHook(event);
    res.statusCode = 202;
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.end(err.error);
    return;
  }

};

exports.apexEvent = data => {
  const diffInMinutes = (a, b) => Math.round(((b-a)/1000)/60);
  const duration = data.alert.window_duration;
  return {
    id: data.alert.id,
    name: data.check.name,
    state: data.state === 'triggered' ? 'down' : 'up',
    duration: data.state === 'resolved' ?
      diffInMinutes(Date.parse(data.triggered_at), Date.parse(data.resolved_at)) + duration : duration,
    date: data.resolved_at ? data.resolved_at : data.triggered_at
  };
};

exports.stackdriverEvent = data => {
  const incident = data.incident;
  const start = DateTime.fromSeconds(incident.started_at);
  const end = incident.ended_at ? DateTime.fromSeconds(incident.ended_at) : null;
  const duration = DateTime.utc().diff(start);

  return {
    id: incident.incident_id,
    name: incident.policy_name,
    state: incident.state === 'open' ? 'down' : 'up',
    duration: incident.state === 'closed' ?
      end.diff(start) : duration,
    date: end ? end : start
  };
};

exports.discordHook = async evt => {
  const duration = Math.round(evt.duration.as('minutes'));

  let desc = '';
  if (evt.state === 'down') {
    desc = `The service is unreachable for longer than ${duration} minute(s)`;
  } else {
    desc = `The service returned to online state after ${duration} minute(s)`;
  }

  const msg = {
    embeds: [{
      title: evt.name,
      description: desc,
      timestamp: evt.date.toISO(),
      url: process.env.STATUS_URL
    }],
    tts: false
  };

  try {
    await got.post(process.env.DISCORD_URL, {json: msg}).json();
  } catch (err) {
    return Promise.reject(err);
  }
};
