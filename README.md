# hivemind-ws

- start redis
- start [hivemind-rails](https://github.com/banjolina-jolie/hivemind-rails), go into `rails console` and copy the output of `Rails.application.secrets.secret_key_base`
- in bash profile set `export JWT_SECRET="<COPIED_SECRET>"`

```
npm install
npm install -g nodemon
nodemon websocket-server.js
```
