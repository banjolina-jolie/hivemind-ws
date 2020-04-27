const redis = require("redis");
const WebSocket = require('ws');
const uws = require('uWebSockets.js');

const PORT = process.env.PORT || 9001;

const redisClientOptions = {};
if (process.env.REDIS_URL) {
  redisClientOptions.url = process.env.REDIS_URL;
}

const isProduction = process.env.NODE_ENV === 'production';

const redisClient = redis.createClient(redisClientOptions);
const qs = require('querystring');

function buffToString(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf));
}

function stringToBuff(str) {
  var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
  var bufView = new Uint8Array(buf);
  for (var i=0, strLen=str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}


// const wss = new WebSocket.Server({ port: PORT });

// wss.on('connection', function connection(ws) {
//   console.log('on connection')

//   ws.on('open', (stuff, things) => {
//     console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~')
//     console.log('stuff');
//     console.log(stuff);
//     console.log('things');
//     console.log(things);
//   });
//   ws.on('message', function incoming(data) {
//     console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
//     console.log('data');
//     console.log(data);
//     // wss.clients.forEach(function each(client) {
//     //   if (client.readyState === WebSocket.OPEN) {
//     //     client.send(data);
//     //   }
//     // });
//   });
// });

const app = uws./*SSL*/App();

try {
  app.ws('/*', {

    open: (ws, req) => {
      console.log('~~~~~~~~~~OPEN~~~~~~~~~~~~')
      // console.log('ws')
      // for (var key in ws) {
      //   console.log(key)
      // }

      const queryParams = qs.parse(req.getQuery());

      if (queryParams.start) {
        console.log('~~~~~~~~~~~START VOTING~~~~~~~~~~~~~');
        if (!ws) {
          console.log('NO WS COWBOY')
        } else {
          ws.publish('start', stringToBuff(JSON.stringify({ start: true, votingRoundEndTime: queryParams.voting_round_end_time})));
        }
      } else if (queryParams.vote_next_word) {
        console.log('~~~~~~~~~~~NEXT VOTING ROUND~~~~~~~~~~~~~');
        ws.publish('vote-next-word', stringToBuff(JSON.stringify({ winningWord: queryParams.winning_word, votingRoundEndTime: queryParams.voting_round_end_time})));
      } else {
        const setName = `${queryParams.question}-scores`;

        redisClient.zrevrangebyscore(setName, '+inf', 1, 'withscores', (err, scores) => {
          if (err) console.log(err);
          ws.send(stringToBuff(JSON.stringify(scores)));
        });

        console.log('~~~~~~~~~~~~~SUBSCRIBING A VOTER~~~~~~~~~~~~~')
        ws.subscribe('topics/scores');
        ws.subscribe('start');
        ws.subscribe('vote-next-word');
      }
    },

    message: (ws, message) => {
      const strMsg = buffToString(message);
      handleNewVoteMessage(ws, strMsg)
    }

  }).get('/*', (res, req) => {
    res.end('Hello World!');
  }).listen(PORT, (listenSocket, thing) => {
    console.log('########LISTEN CALLBACK########')
    if (listenSocket) {
      console.log('listenSocket');
      for (var key in listenSocket) {
        console.log(key);
      }
      console.log('Listening...');
    }
  });
} catch (e) {
  console.log(`***********ERROR**********`)
  console.log(e)
  console.log(e.message)
}

function handleNewVoteMessage(ws, strMsg) {
  console.log('strMsg');
  console.log(strMsg);
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
      if (err) console.log(err);
      ws.publish('topics/scores', stringToBuff(JSON.stringify(scores)));
    });
  }
}
