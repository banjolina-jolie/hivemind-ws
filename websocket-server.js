const http = require('http');
const qs = require('querystring');
const redis = require('redis');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const _ = require('lodash');

// const isProduction = process.env.NODE_ENV === 'production';

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

// const authVoters = {};
// const watchersByIP = {};

const wsByQuestion = {};
let activeHiveCount = 0;


function handleOnConnection(ws, params) {
  const { question, user, vote_next_word, voting_round_end_time, winning_word } = params;

  if (question) {
    wsByQuestion[question] = wsByQuestion[question] || [];
  }

  if (user === 'rails-server' && vote_next_word) {
    console.log('~~~~~~~~~~~NEXT VOTING ROUND~~~~~~~~~~~~~');

    wsByQuestion[question] = wsByQuestion[question].filter(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          winningWord: winning_word,
          votingRoundEndTime: voting_round_end_time,
        }));
        return true;
      } else {
        return ws.readyState === WebSocket.CONNECTING;
      }
    });

    if (winning_word === '(complete-answer)') {
      delete wsByQuestion[question];
    }

  } else {
    console.log('~~~~~~~~~~~SUBSCRIBE VOTER~~~~~~~~~~~~~');
    wsByQuestion[question].push(ws);
    // Let everyone see the new voter
    throttledScoreBroadcast(question);
  }
}

wss.on('connection', function connection(ws, req) {
  const ip = req.socket.remoteAddress;
  const params = qs.parse(req.url.slice(2));

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

        activeHiveCount++;

        ws.on('close', () => {
          activeHiveCount--;
        });
      }
    }
  });

  handleOnConnection(ws, params);

  if (params.question) {
    ws.on('close', () => {
      if (wsByQuestion[params.question]) {
        // remove ws from wsByQuestion[params.question]
        wsByQuestion[params.question] = wsByQuestion[params.question].filter(w => w !== ws)

        if (!wsByQuestion[params.question].length) {
          // delete empty list
          delete wsByQuestion[params.question];
        }
      }
    });
  }
});

server.on('upgrade', function upgrade(request, socket, head) {
  const qsParams = qs.parse(request.url.slice(2));

  // TODO: do we wanna use this pattern instead?
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

    const websockets = wsByQuestion[questionId];

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
