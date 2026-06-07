const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const bots = {}; 
const clients = []; 

// Broadcasts logs to the UI
function sendLog(msg) {
    const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(logEntry);
    clients.forEach(client => client.write(`data: ${logEntry}\n\n`));
}

// SSE Endpoint for live console
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => clients.splice(clients.indexOf(res), 1));
});

app.post('/api/bots/add', (req, res) => {
    const { username, password } = req.body;
    
    if (bots[username]) {
        return res.status(400).send({ status: 'error', message: 'Bot already active' });
    }

    sendLog(`Starting bot: ${username}`);

    const bot = mineflayer.createBot({
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    });

    bot.once('spawn', () => {
        sendLog(`${username} spawned. Executing login sequence...`);
        setTimeout(() => {
            bot.chat(`/login ${password}`);
            setTimeout(() => {
                bot.chat('/survival');
                sendLog(`${username} executed /survival.`);
            }, 3000);
        }, 1000);
    });

    bot.on('kicked', reason => sendLog(`${username} kicked: ${reason}`));
    bot.on('error', err => sendLog(`${username} error: ${err.message}`));
    bot.on('end', () => {
        sendLog(`${username} disconnected.`);
        delete bots[username];
    });

    bots[username] = bot;
    res.send({ status: 'success', message: `${username} connection initiated.` });
});

app.post('/api/bots/disconnect', (req, res) => {
    const { username } = req.body;
    if (bots[username]) {
        bots[username].quit();
        delete bots[username];
        res.send({ status: 'success', message: `${username} disconnected.` });
    } else {
        res.status(404).send({ status: 'error', message: 'Bot not found.' });
    }
});

app.post('/api/bots/chat', (req, res) => {
    const { target, message } = req.body;
    if (target === 'all') {
        Object.values(bots).forEach(b => b.chat(message));
        sendLog(`Broadcasted: ${message}`);
    } else if (bots[target]) {
        bots[target].chat(message);
        sendLog(`${target} said: ${message}`);
    }
    res.send({ status: 'success', message: 'Message sent.' });
});

app.get('/api/bots/:username/inventory', (req, res) => {
    const bot = bots[req.params.username];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });
    
    const items = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
    sendLog(`Checked inventory for ${req.params.username}`);
    res.send(items);
});

app.listen(process.env.PORT || 3000);
