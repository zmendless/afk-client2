const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path'); // Added for file paths
const app = express();

app.use(express.json());

// Serve index.html from the root folder
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const bots = {}; 

app.post('/api/bots/add', (req, res) => {
    const { username, password } = req.body;
    
    const bot = mineflayer.createBot({
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    });

    bot.once('spawn', () => {
        setTimeout(() => {
            bot.chat(`/login ${password}`);
            setTimeout(() => bot.chat('/survival'), 3000);
        }, 1000);
    });

    bots[username] = bot;
    res.send({ status: 'connected', username });
});

app.post('/api/bots/disconnect', (req, res) => {
    const { username } = req.body;
    if (bots[username]) {
        bots[username].quit();
        delete bots[username];
    }
    res.send({ status: 'disconnected' });
});

app.post('/api/bots/chat', (req, res) => {
    const { target, message } = req.body;
    if (target === 'all') {
        Object.values(bots).forEach(b => b.chat(message));
    } else if (bots[target]) {
        bots[target].chat(message);
    }
    res.send({ status: 'sent' });
});

app.get('/api/bots/:username/inventory', (req, res) => {
    const bot = bots[req.params.username];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });
    
    const items = bot.inventory.items().map(item => ({ 
        name: item.name, 
        count: item.count 
    }));
    res.send(items);
});

app.listen(process.env.PORT || 3000);
