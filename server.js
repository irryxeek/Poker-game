const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// ------------------------------------------
// 1. 极简的内存数据结构
// ------------------------------------------
let gameState = {
    players: [],      // 存放入座玩家: { id, name, hand, chips }
    gameStarted: false,
    deck: [],         // 牌堆
    communityCards: [] // 公共牌
};

// 简单的扑克牌生成器 (花色: s=黑桃, h=红桃, d=方片, c=梅花)
const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) {
        for (let r of RANKS) {
            deck.push(r + s); // 例如: "As" (黑桃A), "Td" (方片10)
        }
    }
    // 洗牌算法 (Fisher-Yates)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// ------------------------------------------
// 2. WebSocket 事件处理 (核心逻辑)
// ------------------------------------------
io.on('connection', (socket) => {
    console.log('新连接接入:', socket.id);

    // 【事件: 玩家入座】
    socket.on('join', (playerName) => {
        // 如果房间满了(假设6人)或游戏已开始，则拒绝(这里省略判断)
        
        const newPlayer = {
            id: socket.id,
            name: playerName || `玩家${socket.id.substr(0,4)}`,
            hand: [],
            chips: 1000,
            isFolded: false
        };
        
        gameState.players.push(newPlayer);
        
        // 广播：告诉所有人“有新人来了”，并发送最新状态
        io.emit('update_state', gameState);
    });

    // 【事件: 开始游戏】(仅作为演示，任何人都能点开始)
    socket.on('start_game', () => {
        if (gameState.players.length < 2) return; // 至少2人

        gameState.gameStarted = true;
        gameState.deck = createDeck();
        gameState.communityCards = [];

        // 发手牌 (每人2张)
        gameState.players.forEach(player => {
            player.hand = [gameState.deck.pop(), gameState.deck.pop()];
            player.isFolded = false;
        });

        // 广播全量状态 (注意：实际开发中，别人的手牌应该屏蔽，这里为了演示全发)
        io.emit('update_state', gameState);
        
        // 广播系统消息
        io.emit('system_msg', '游戏开始！已发牌！');
    });

    // 【事件: 断开连接】
    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        io.emit('update_state', gameState);
    });
});

// ------------------------------------------
// 3. 启动服务器
// ------------------------------------------
// 托管当前目录下的静态文件(用于访问 index.html)
app.use(express.static(__dirname));

http.listen(3000, () => {
    console.log('服务器已启动: http://localhost:3000');
});