const http = require('http');
const qs = require('querystring');
const redis = require('redis');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const _ = require('lodash');

// const isProduction = process.env.NODE_ENV === 'production';
const isProduction = false;
const PORT = process.env.PORT || 9001;
// Should be equal to value of `Rails.application.secrets.secret_key_base` from hivemind-rails
const JWT_SECRET = process.env.JWT_SECRET;

const redisClientOptions = {};
if (process.env.REDIS_URL) {
  redisClientOptions.url = process.env.REDIS_URL;
}
const redisClient = redis.createClient(redisClientOptions);

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

// Development
const authVoters = {};

const authVotersByIP = {};
/*
  authVotersByIP = {
    <QUESTION_ID>: {
      <IP>: <WS>
    }
  }
*/

function handleOnConnection(ws, ip, params) {
  const { question, user, vote_next_word, voting_round_end_time, winning_word } = params;

  if (question) {
    if (isProduction) {
      authVotersByIP[question] = authVotersByIP[question] || {};
    } else {
      authVoters[question] = authVoters[question] || [];
    }
  }

  if (user === 'rails-server' && vote_next_word) {
    console.log('~~~~~~~~~~~NEXT VOTING ROUND~~~~~~~~~~~~~');

    if (isProduction) {
      Object.values(authVotersByIP[question]).forEach(ws => {
        ws.send(JSON.stringify({
          winningWord: winning_word,
          votingRoundEndTime: voting_round_end_time,
        }));
      });
    } else {
      // DEVELOPMENT
      authVoters[question].forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ winningWord: winning_word, votingRoundEndTime: voting_round_end_time}));
          return true;
        } else {
          return ws.readyState === WebSocket.CONNECTING;
        }
      });
    }

    if (winning_word === '(complete-answer)') {
      delete authVotersByIP[question]; // TODO: Clear question?
    }

  } else {
    console.log('~~~~~~~~~~~SUBSCRIBE VOTER~~~~~~~~~~~~~');

    if (isProduction) {
      authVotersByIP[question][ip] = ws; // use user id?
    } else {
      // DEVELOPMENT
      authVoters[question] = authVoters[question].filter(wsObj => wsObj.ip !== ip);
      authVoters[question].push({ ws, ip });
    }

    let activeHive = isProduction ? Object.values(authVotersByIP[question] || {}) : (authVoters[question] || []).map(x => x.ws);
    const activeHiveCount = activeHive.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;

    const sortedSetKey = `${question}-scores`;
    redisClient.zrevrangebyscore(sortedSetKey, '+inf', 1, 'withscores', (err, scores) => {
      if (err) console.log(err);
      ws.send(JSON.stringify({
        activeHiveCount,
        scores,
      }));
    });
  }
}

wss.on('connection', function connection(ws, req) {
  const ip = req.socket.remoteAddress;
  const params = qs.parse(req.url.slice(2));

  if (params.auth) {
    jwt.verify(params.auth, JWT_SECRET, (err, decoded) => {
      if (err) {
        console.log(err);
        ws.send('invalid auth'); // TODO: have frontend respond to this
      } else {
        if (decoded && decoded.user_id === params.user) {
          // only handle messages from properly authenticated users
          ws.on('message', function incoming(data) {
            // TODO: don't register vote til after startTime
            handleNewVoteMessage(ws, data, params.user)
          });
        }

      }
    });

    handleOnConnection(ws, ip, params);
  }

  if (params.question) {
    ws.on('close', (ip => {
      return function onClose() {
        if (authVotersByIP[params.question]) {
          // remove ws from memory
          delete authVotersByIP[params.question][ip];
          if (!Object.keys(authVotersByIP[params.question]).length) {
            // delete empty list
            delete authVotersByIP[params.question];
          }
        }
      }
    })(ip));
  }
});

server.on('upgrade', function upgrade(request, socket, head) {
  const qsParams = qs.parse(request.url.slice(2));

  // authenticate(qsParams, err => {
    // if (err) {
    //   socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    //   socket.destroy();
    //   return;
    // }

    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
});

server.listen(PORT);

function getScoresAndPublish(questionId) {
  const sortedSetKey = `${questionId}-scores`;

  redisClient.zrevrangebyscore(sortedSetKey, '+inf', 1, 'withscores', (err, scores) => {
    if (err) { console.log(err) }

    const websockets = isProduction ? Object.values(authVotersByIP[questionId] || {}) : authVoters[questionId].map(x => x.ws);
    const activeHiveCount = (websockets || []).length;

    (websockets || []).forEach(ws => {
      ws.send(JSON.stringify({
        activeHiveCount,
        scores,
      }));
    });

  });
}

// TODO: Create separate throttledScoreBroadcast function per questionId
const throttledScoreBroadcast = _.throttle(getScoresAndPublish, 250);

function handleNewVoteMessage(ws, strMsg, userId) {
  const [questionId, word] = strMsg.split(' ');

  if (!questionId) { return }

  const sortedSetKey = `${questionId}-scores`;
  const playerChoiceKey = `${questionId}-${userId}`;

  if (!word) {
    // if voting for a null word, delete player
    redisClient.del(playerChoiceKey);
    throttledScoreBroadcast(questionId);
    return;
  }

  // word is too big
  if (word && word.length > 35) { return }

  // get current word vote and decrement it
  redisClient.get(playerChoiceKey, decOldVote);

  function decOldVote(e, wordToDec) {
    if (e) { console.log(e) }

    if (wordToDec) {
      console.log(`decrementing vote for ${wordToDec}`)
      redisClient.zincrby(sortedSetKey, -1, wordToDec, incNewVote);
    } else {
      incNewVote();
    }
  }

  function incNewVote() {
    // if (word) {
      const sanitizedWord = word === '(complete-answer)' ? word : word.replace(/[^a-zA-Z]/g, '').toLowerCase();
      console.log(`incrementing ${sanitizedWord}`);
      redisClient.zincrby(sortedSetKey, 1, sanitizedWord, setNewVote);
    // } else {
    //   console.log(`blank vote deleting player`)
    //   redisClient.del(playerChoiceKey);
    //   throttledScoreBroadcast(questionId);
    // }
  }

  function setNewVote() {
    redisClient.set(playerChoiceKey, word, () => throttledScoreBroadcast(questionId));
  }

}
