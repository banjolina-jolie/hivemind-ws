const http = require('http');
const qs = require('querystring');
const redis = require('redis');
const WebSocket = require('ws');

const PORT = process.env.PORT || 9001;

const redisClientOptions = {};
if (process.env.REDIS_URL) {
  redisClientOptions.url = process.env.REDIS_URL;
}

const isProduction = process.env.NODE_ENV === 'production';

const redisClient = redis.createClient(redisClientOptions);

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

// Development
const questionSubscribers = {};


const voterWsByIP = {};
/*
  voterWsByIP = {
    <QUESTION_ID>: {
      <IP>: <WS>
    }
  }
*/
const audienceWsByIP = {}; // TODO: use this for non authenticated users

function handleOnConnection(ws, ip, params) {
  if (params.question) {
    voterWsByIP[params.question] = voterWsByIP[params.question] || {};

    questionSubscribers[params.question] = questionSubscribers[params.question] || [];
  }

  if (params.start) {
    console.log('~~~~~~~~~~~START VOTING~~~~~~~~~~~~~');

    if (isProduction) {
      Object.values(voterWsByIP[params.question]).forEach(ws => {
        ws.send(JSON.stringify({
          start: true,
          votingRoundEndTime: params.voting_round_end_time,
        }));
      });
    } else {
      // DEVELOPMENT
      questionSubscribers[params.question].forEach(ws => {
        ws.send(JSON.stringify({
          start: true,
          votingRoundEndTime: params.voting_round_end_time,
        }));
      })
    }


  } else if (params.vote_next_word) {
    console.log('~~~~~~~~~~~NEXT VOTING ROUND~~~~~~~~~~~~~');

    if (isProduction) {
      Object.values(voterWsByIP[params.question]).forEach(ws => {
        ws.send(JSON.stringify({
          winningWord: params.winning_word,
          votingRoundEndTime: params.voting_round_end_time,
        }));
      });
    } else {
      // DEVELOPMENT
      questionSubscribers[params.question] = questionSubscribers[params.question].filter(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ winningWord: params.winning_word, votingRoundEndTime: params.voting_round_end_time}));
          return true;
        } else {
          return ws.readyState === WebSocket.CONNECTING;
        }
      });
    }

    if (params.winning_word === '(complete-answer)') {
      // delete voterWsByIP[params.question] // TODO: ?
    }
  } else {
    console.log('~~~~~~~~~~~SUBSCRIBE VOTER~~~~~~~~~~~~~');

    if (isProduction) {
      voterWsByIP[params.question][ip] = ws;
    } else {
      // DEVELOPMENT
      questionSubscribers[params.question].push(ws);
    }

    const activeHiveCount = isProduction ? Object.values(voterWsByIP[params.question] || {}).length : (questionSubscribers[params.question] || []).length;

    const setName = `${params.question}-scores`;
    redisClient.zrevrangebyscore(setName, '+inf', 1, 'withscores', (err, scores) => {
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
  handleOnConnection(ws, ip, params);

  ws.on('message', function incoming(data) {
    handleNewVoteMessage(ws, data)
  });

  if (params.question) {
    ws.on('close', (ip => {
      return function onClose() {
        if (voterWsByIP[params.question]) {
          // remove ws from memory
          delete voterWsByIP[params.question][ip];
          if (!Object.keys(voterWsByIP[params.question]).length) {
            // delete empty voterWsByIP[params.question]
            delete voterWsByIP[params.question];
          }
        }
      }
    })(ip));
  }
});

// function authenticate(params, cb) {
//   cb(null);
// }

server.on('upgrade', function upgrade(request, socket, head) {
  // This function is not defined on purpose. Implement it with your own logic.
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
  // });
});

server.listen(PORT);

function handleNewVoteMessage(ws, strMsg) {
  const [player, word, questionId] = strMsg.split(' ');

  if (!player || !questionId) { return }

  const playerChoiceKey = `${questionId}-${player}`;

  // if (!word) {
  //   // if voting for a null word, delete player
  //   redisClient.del(playerChoiceKey);
  //   return;
  // }

  const setName = `${questionId}-scores`;

  // get current
  redisClient.get(playerChoiceKey, decOldVote);

  function decOldVote(e, wordToDec) {
    if (e) { console.log(e) }

    if (wordToDec) {
      console.log(`decrementing vote for ${wordToDec}`)
      redisClient.zincrby(setName, -1, wordToDec, incNewVote);
    } else {
      incNewVote();
    }
  }

  function incNewVote() {
    if (word && word !== '<BLANK_VOTE>') {
      console.log(`incrementing ${word}`)
      redisClient.zincrby(setName, 1, word, setNewVote);
    } else {
      console.log(`blank vote deleting player`)
      redisClient.del(playerChoiceKey);
      getScoresAndPublish();
    }
  }

  function setNewVote() {
    redisClient.set(`${questionId}-${player}`, word, getScoresAndPublish);
  }

  function getScoresAndPublish() {
    redisClient.zrevrangebyscore(setName, '+inf', 1, 'withscores', (err, scores) => {
      if (err) { console.log(err) }

      const websockets = isProduction ? Object.values(voterWsByIP[questionId] || {}) : questionSubscribers[questionId];
      const activeHiveCount = (websockets || []).length;

      (websockets || []).forEach(ws => {
        ws.send(JSON.stringify({
          activeHiveCount,
          scores,
        }));
      });

    });
  }
}
