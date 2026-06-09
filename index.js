const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const app = express();

app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const bots = {}; 
const attackIntervals = {};
const attackConfigs = {}; 
const survivalIntervals = {}; // New: Track survival intervals
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
    res.send(Object.values(bots).map(b => b.originalName));
});

function initBot(username, password) {
    const botId = username.toLowerCase();
    if (bots[botId]) return null;

    sendLog(`Starting bot: ${username}`);
    const bot = mineflayer.createBot({
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    });

    bot.originalName = username;

    bot.once('spawn', () => {
        sendLog(`${username} spawned. Executing login...`);
        setTimeout(() => {
            bot.chat(`/login ${password}`);
            setTimeout(() => {
                bot.chat('/survival');
                sendLog(`${username} executed /survival.`);
                
                // NEW: Start sending /survival every 10 minutes (600,000 ms)
                survivalIntervals[botId] = setInterval(() => {
                    if (bots[botId]) {
                        bots[botId].chat('/survival');
                        sendLog(`${username} auto-executed /survival (10m loop).`);
                    }
                }, 600000);
                
                if (attackConfigs[botId] && attackConfigs[botId].active) {
                    sendLog(`Resuming attack loop for ${username}...`);
                    delete attackIntervals[botId]; 
                    manageAttackInterval(botId, attackConfigs[botId].delay, 'start');
                }
            }, 3000);
        }, 1000);
    });

    // NEW: Listen to public server chat and send to web terminal
    bot.on('chat', (usernameSender, message) => {
        if (usernameSender === bot.username) return; // Don't log own messages twice
        sendLog(`[CHAT] <${usernameSender}> ${message}`);
    });

    // Handle private messages (whispers) just in case
    bot.on('whisper', (usernameSender, message) => {
        sendLog(`[WHISPER] from <${usernameSender}>: ${message}`);
    });

    bot.on('kicked', reason => {
        sendLog(`${username} kicked: ${reason}`);
        handleConnectionLoss(username, password, botId);
    });
    
    bot.on('error', err => {
        sendLog(`${username} error: ${err.message}`);
        handleConnectionLoss(username, password, botId);
    });
    
    bot.on('end', () => {
        sendLog(`${username} disconnected.`);
        cleanupBotState(botId);
    });

    bots[botId] = bot;
    return bot;
}

// Helper function to cleanly delete a bot's running processes
function cleanupBotState(botId) {
    delete bots[botId];
    
    if (attackIntervals[botId]) {
        clearInterval(attackIntervals[botId]);
        delete attackIntervals[botId];
    }
    if (survivalIntervals[botId]) {
        clearInterval(survivalIntervals[botId]);
        delete survivalIntervals[botId];
    }
}

function handleConnectionLoss(username, password, botId) {
    cleanupBotState(botId);
    sendLog(`${username} connection lost. Reconnecting in 30s...`);
    
    setTimeout(() => {
        if (!bots[botId]) initBot(username, password);
    }, 30000); 
}

function manageAttackInterval(botId, delaySeconds, action) {
    const bot = bots[botId];
    if (!bot) return { status: 'error', message: 'Bot offline.' };
    const username = bot.originalName;

    if (action === 'start') {
        if (attackIntervals[botId]) return { status: 'error', message: 'Already attacking.' };
        attackConfigs[botId] = { active: true, delay: delaySeconds };
        
        sendLog(`Starting sweep attack loop for ${username} (${delaySeconds}s)`);
        const intervalId = setInterval(() => {
            const activeBot = bots[botId];
            if (activeBot && activeBot.entity) {
                const target = activeBot.nearestEntity(entity => {
                    return entity.name === 'armor_stand' &&
                           entity.position.distanceTo(activeBot.entity.position) < 4;
                });

                if (target) activeBot.attack(target); 
                else activeBot.swingArm('right');
            } else {
                clearInterval(intervalId);
                delete attackIntervals[botId];
            }
        }, delaySeconds * 1000);
        
        attackIntervals[botId] = intervalId;
        return { status: 'success', message: 'Attack started.' };
    } 
    
    if (action === 'stop') {
        if (!attackIntervals[botId]) return { status: 'error', message: 'Not attacking.' };
        if (attackConfigs[botId]) attackConfigs[botId].active = false;
        
        clearInterval(attackIntervals[botId]);
        delete attackIntervals[botId];
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
        res.status(400).send({ status: 'error', message: `Bot active.` });
    }
});

app.post('/api/bots/disconnect', (req, res) => {
    const botId = req.body.username.toLowerCase();
    if (bots[botId]) {
        if (attackConfigs[botId]) attackConfigs[botId].active = false;
        bots[botId].quit();
        // NOTE: cleanupBotState is automatically called via the 'end' event listener
        res.send({ status: 'success', message: `Disconnected.` });
    } else {
        res.status(404).send({ status: 'error', message: 'Bot not found.' });
    }
});

app.post('/api/bots/chat', (req, res) => {
    const target = req.body.target.toLowerCase();
    const { message } = req.body;
    
    if (target === 'all') {
        Object.values(bots).forEach(b => b.chat(message));
        sendLog(`[OUTGOING BROADCAST]: ${message}`);
    } else if (bots[target]) {
        bots[target].chat(message);
        sendLog(`[OUTGOING] ${bots[target].originalName}: ${message}`);
    } else {
        return res.status(404).send({ status: 'error', message: 'Target offline.' });
    }
    res.send({ status: 'success', message: 'Message sent.' });
});

app.post('/api/bots/hotbar', (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });

    const slotInt = parseInt(req.body.slot);
    if (isNaN(slotInt) || slotInt < 0 || slotInt > 8) return res.status(400).send({ error: 'Invalid slot' });

    bot.setQuickBarSlot(slotInt);
    sendLog(`${bot.originalName} changed hotbar to ${slotInt}`);
    res.send({ status: 'success', message: `Slot set` });
});

app.get('/api/bots/:username/inventory', (req, res) => {
    const botId = req.params.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });
    res.send(bot.inventory.items().map(item => ({ name: item.name, count: item.count })));
});

app.post('/api/bots/drop', async (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline.' });

    const items = bot.inventory.items();
    if (items.length === 0) return res.send({ status: 'success', message: 'EMPTY' });

    res.send({ status: 'success', message: 'DROPPING' });
    sendLog(`${bot.originalName} jettisoning...`);

    await bot.waitForTicks(10); 
    for (const item of items) {
        try {
            await bot.tossStack(item);
            await bot.waitForTicks(5); 
        } catch (err) {
            sendLog(`[ERR] Drop failed: ${err.message}`);
        }
    }
});

app.post('/api/bots/attack/start', (req, res) => {
    const response = manageAttackInterval(req.body.username.toLowerCase(), req.body.delay, 'start');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.post('/api/bots/attack/stop', (req, res) => {
    const response = manageAttackInterval(req.body.username.toLowerCase(), null, 'stop');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.listen(process.env.PORT || 3000);
