const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const app = express();

app.use(express.json());

// Serve index.html from the root folder
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Global objects for bot instances and attack intervals
const bots = {}; 
const attackIntervals = {};
const clients = []; // SSE log listeners

// Helper: Broadcasts logs to the UI
function sendLog(msg) {
    const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(logEntry); // Server console
    clients.forEach(client => client.write(`data: ${logEntry}\n\n`)); // UI Console stream
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


// Function to abstract bot initialization, listeners, and login
function initBot(username, password) {
    if (bots[username]) {
        sendLog(`Error: Bot ${username} already active.`);
        return null;
    }

    sendLog(`Starting bot: ${username}`);

    const botConfig = {
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    };

    const bot = mineflayer.createBot(botConfig);

    // Login sequence logic
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

    // Logging and rejoining listeners
    bot.on('chat', (sender, message) => sendLog(`${username} chat: <${sender}> ${message}`));
    bot.on('whisper', (sender, message) => sendLog(`${username} whisper from ${sender}: ${message}`));
    
    bot.on('kicked', reason => {
        sendLog(`${username} kicked. Reason: ${reason}`);
        handleConnectionLoss(username, password);
    });
    
    bot.on('error', err => {
        sendLog(`${username} connection error: ${err.message}`);
        handleConnectionLoss(username, password);
    });
    
    bot.on('end', () => {
        sendLog(`${username} disconnected.`);
        // Note: Reconnect is triggered by kicked/error, 'end' is final cleanup.
        delete bots[username];
        // Ensure attack interval is also cleared on final disconnect
        if (attackIntervals[username]) {
            clearInterval(attackIntervals[username]);
            delete attackIntervals[username];
            sendLog(`${username} attack interval cleared due to disconnection.`);
        }
    });

    bots[username] = bot;
    return bot;
}


// Handle Connection Loss and Rejoining Logic
function handleConnectionLoss(username, password) {
    // Clear any active attack interval linked to this bot instance
    if (attackIntervals[username]) {
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
        sendLog(`${username} attack interval cleared before rejoining.`);
    }

    // Crucially, delete the *current* bot instance so a new one can be made.
    // The 'end' listener will also call this, but the logic needs careful sequence.
    delete bots[username];
    
    sendLog(`${username} connection lost. Scheduling reconnection...`);
    
    // Auto-Rejoining Wait Logic: Exactly 30 seconds
    setTimeout(() => {
        if (bots[username]) {
            sendLog(`Bot ${username} is already reconnected, skipping auto-rejoin.`);
            return;
        }
        
        sendLog(`${username} attempting auto-reconnection...`);
        // We call initBot with the original credentials to make a new connection
        initBot(username, password);
    }, 30000); // 30 seconds
}


// Function to handle the attack intervals
function manageAttackInterval(username, delaySeconds, action) {
    const bot = bots[username];
    if (!bot) {
        sendLog(`Error: Bot ${username} is not online.`);
        return { status: 'error', message: 'Bot not found.' };
    }

    if (action === 'start') {
        if (attackIntervals[username]) {
            return { status: 'error', message: 'Bot is already attacking.' };
        }
        
        // Attack delay logic: convert seconds to ms
        const delayMs = delaySeconds * 1000;
        sendLog(`Starting attack loop for ${username} every ${delaySeconds}s.`);
        
        // Start the periodic attack interval
        const intervalId = setInterval(() => {
            // Periodically check if bot instance and its entity are valid to avoid crash
            const activeBot = bots[username];
            if (activeBot && activeBot.entity) {
                activeBot.attack();
                sendLog(`${username} attacked (loop).`);
            } else {
                // If bot instance is invalid, clear interval
                clearInterval(intervalId);
                delete attackIntervals[username];
                sendLog(`Cleared attack loop for ${username} as the bot is no longer online.`);
            }
        }, delayMs);
        
        attackIntervals[username] = intervalId;
        return { status: 'success', message: 'Attack loop started.' };
    } 
    
    if (action === 'stop') {
        if (!attackIntervals[username]) {
            return { status: 'error', message: 'Bot is not attacking.' };
        }
        
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
        sendLog(`Stopped attack loop for ${username}.`);
        return { status: 'success', message: 'Attack loop stopped.' };
    }

    return { status: 'error', message: 'Invalid action.' };
}


// --- API ENDPOINTS ---

// Original endpoints modified to use refracted functions
app.post('/api/bots/add', (req, res) => {
    const { username, password } = req.body;
    const bot = initBot(username, password);
    if (bot) {
        res.send({ status: 'success', message: `${username} connection initiated.` });
    } else {
        // If bot creation fails (conflict), the status: 'error' response is built inside initBot
        res.status(400).send({ status: 'error', message: `Conflict: Bot ${username} already active.` });
    }
});

app.post('/api/bots/disconnect', (req, res) => {
    const { username } = req.body;
    if (bots[username]) {
        // The normal disconnect sequence starts here. 'end' handles interval cleanup.
        bots[username].quit();
        res.send({ status: 'success', message: `${username} disconnected.` });
    } else {
        res.status(404).send({ status: 'error', message: 'Bot not found.' });
    }
});

// Broadcast/Chat to one endpoint
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

// New attack endpoints
app.post('/api/bots/attack/start', (req, res) => {
    const { username, delay } = req.body;
    const response = manageAttackInterval(username, delay, 'start');
    if (response.status === 'success') {
        res.send(response);
    } else {
        res.status(400).send(response);
    }
});

app.post('/api/bots/attack/stop', (req, res) => {
    const { username } = req.body;
    const response = manageAttackInterval(username, null, 'stop');
    if (response.status === 'success') {
        res.send(response);
    } else {
        res.status(400).send(response);
    }
});

app.listen(process.env.PORT || 3000);
