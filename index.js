const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const app = express();

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const bots = {}; 
const attackIntervals = {};
const attackConfigs = {}; 
const clients = []; 

function sendLog(msg) {
    const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(logEntry); 
    clients.forEach(client => client.write(`data: ${logEntry}\n\n`)); 
}

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => clients.splice(clients.indexOf(res), 1));
});

app.get('/api/bots', (req, res) => {
    res.send(Object.keys(bots));
});

function initBot(username, password) {
    if (bots[username]) return null;

    sendLog(`Starting bot: ${username}`);
    const bot = mineflayer.createBot({
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    });

    bot.once('spawn', () => {
        sendLog(`${username} spawned. Executing login...`);
        setTimeout(() => {
            bot.chat(`/login ${password}`);
            setTimeout(() => {
                bot.chat('/survival');
                sendLog(`${username} executed /survival.`);
                
                if (attackConfigs[username] && attackConfigs[username].active) {
                    sendLog(`Resuming attack loop for ${username}...`);
                    delete attackIntervals[username]; 
                    manageAttackInterval(username, attackConfigs[username].delay, 'start');
                }
            }, 3000);
        }, 1000);
    });

    bot.on('kicked', reason => {
        sendLog(`${username} kicked: ${reason}`);
        handleConnectionLoss(username, password);
    });
    
    bot.on('error', err => {
        sendLog(`${username} error: ${err.message}`);
        handleConnectionLoss(username, password);
    });
    
    bot.on('end', () => {
        sendLog(`${username} disconnected.`);
        delete bots[username];
        if (attackIntervals[username]) {
            clearInterval(attackIntervals[username]);
            delete attackIntervals[username];
        }
    });

    bots[username] = bot;
    return bot;
}

function handleConnectionLoss(username, password) {
    if (attackIntervals[username]) {
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
    }
    delete bots[username];
    sendLog(`${username} connection lost. Reconnecting in 30s...`);
    
    setTimeout(() => {
        if (!bots[username]) initBot(username, password);
    }, 30000); 
}

function manageAttackInterval(username, delaySeconds, action) {
    const bot = bots[username];
    if (!bot) return { status: 'error', message: 'Bot offline.' };

    if (action === 'start') {
        if (attackIntervals[username]) return { status: 'error', message: 'Already attacking.' };
        attackConfigs[username] = { active: true, delay: delaySeconds };
        
        sendLog(`Starting sweep attack loop for ${username} (${delaySeconds}s)`);
        const intervalId = setInterval(() => {
            const activeBot = bots[username];
            if (activeBot && activeBot.entity) {
                const target = activeBot.nearestEntity(entity => {
                    return entity.name === 'armor_stand' &&
                           entity.position.distanceTo(activeBot.entity.position) < 4;
                });

                if (target) {
                    activeBot.attack(target); 
                } else {
                    activeBot.swingArm('right');
                }
            } else {
                clearInterval(intervalId);
                delete attackIntervals[username];
            }
        }, delaySeconds * 1000);
        
        attackIntervals[username] = intervalId;
        return { status: 'success', message: 'Attack started.' };
    } 
    
    if (action === 'stop') {
        if (!attackIntervals[username]) return { status: 'error', message: 'Not attacking.' };
        if (attackConfigs[username]) attackConfigs[username].active = false;
        
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
        sendLog(`Stopped attack loop for ${username}.`);
        return { status: 'success', message: 'Attack stopped.' };
    }
    return { status: 'error', message: 'Invalid action.' };
}

app.post('/api/bots/add', (req, res) => {
    const { username, password } = req.body;
    if (initBot(username, password)) {
        res.send({ status: 'success', message: `${username} initiated.` });
    } else {
        res.status(400).send({ status: 'error', message: `Bot ${username} active.` });
    }
});

app.post('/api/bots/disconnect', (req, res) => {
    const { username } = req.body;
    if (bots[username]) {
        if (attackConfigs[username]) attackConfigs[username].active = false;
        bots[username].quit();
        res.send({ status: 'success', message: `${username} disconnected.` });
    } else {
        res.status(404).send({ status: 'error', message: 'Bot not found.' });
    }
});

app.post('/api/bots/chat', (req, res) => {
    const { target, message } = req.body;
    if (target === 'all') {
        Object.values(bots).forEach(b => b.chat(message));
        sendLog(`Broadcasted to all: ${message}`);
    } else if (bots[target]) {
        bots[target].chat(message);
        sendLog(`${target} said: ${message}`);
    } else {
        return res.status(404).send({ status: 'error', message: 'Target bot offline.' });
    }
    res.send({ status: 'success', message: 'Message sent.' });
});

// New endpoint: Swap hotbar slot (0-8)
app.post('/api/bots/hotbar', (req, res) => {
    const { username, slot } = req.body;
    const bot = bots[username];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });

    const slotInt = parseInt(slot);
    if (isNaN(slotInt) || slotInt < 0 || slotInt > 8) {
        return res.status(400).send({ error: 'Invalid slot index.' });
    }

    bot.setQuickBarSlot(slotInt);
    sendLog(`${username} changed active hotbar slot to ${slotInt}`);
    res.send({ status: 'success', message: `Slot set to ${slotInt}` });
});

app.get('/api/bots/:username/inventory', (req, res) => {
    const bot = bots[req.params.username];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });
    res.send(bot.inventory.items().map(item => ({ name: item.name, count: item.count })));
});

app.post('/api/bots/attack/start', (req, res) => {
    const response = manageAttackInterval(req.body.username, req.body.delay, 'start');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.post('/api/bots/attack/stop', (req, res) => {
    const response = manageAttackInterval(req.body.username, null, 'stop');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.listen(process.env.PORT || 3000);
