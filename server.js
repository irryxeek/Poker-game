const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const Hand = require('pokersolver').Hand;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ------------------------------------------
// 数据结构
// ------------------------------------------
let gameState = {
    players: [],
    deck: [],
    communityCards: [],
    stage: 'waiting', 
    pot: 0,
    activeSeat: 0,    // 当前行动的座位索引
    dealerSeat: 0,    // 庄家位置 (用于定盲注)
    currentMaxBet: 0, // 本轮单人最高下注额
    lastAggressor: -1 // 最后一个加注的人(用于判断回合结束)
};

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) for (let r of RANKS) deck.push(r + s);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// ------------------------------------------
// 核心逻辑
// ------------------------------------------

// 寻找下一个未弃牌的玩家
function getNextActiveSeat(currentSeat) {
    let next = currentSeat;
    let count = 0;
    do {
        next = (next + 1) % gameState.players.length;
        count++;
    } while (gameState.players[next].folded && count < gameState.players.length);
    return next;
}

// 检查本轮下注是否结束
function checkRoundEnd() {
    // 活跃玩家数
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // 如果只剩1个人，直接赢
    if (activePlayers.length === 1) {
        finishGame(activePlayers[0]);
        return true;
    }

    // 核心判断：是否回到最后一个加注者，且下注额都齐平
    // 如果下一个人就是 lastAggressor，说明转了一圈没人加注，回合结束
    // 这里简化逻辑：只要所有未弃牌玩家的 bet == currentMaxBet，且大家都操作过
    const allMatched = activePlayers.every(p => p.bet === gameState.currentMaxBet && p.hasActed);

    if (allMatched) {
        nextStage();
        return true;
    }
    return false;
}

function nextStage() {
    // 归还筹码进底池，重置本轮下注额
    gameState.players.forEach(p => {
        gameState.pot += p.bet;
        p.bet = 0;
        p.hasActed = false;
    });
    gameState.currentMaxBet = 0;

    // 阶段流转
    if (gameState.stage === 'preflop') {
        gameState.stage = 'flop';
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
    } else if (gameState.stage === 'flop') {
        gameState.stage = 'turn';
        gameState.communityCards.push(gameState.deck.pop());
    } else if (gameState.stage === 'turn') {
        gameState.stage = 'river';
        gameState.communityCards.push(gameState.deck.pop());
    } else if (gameState.stage === 'river') {
        gameState.stage = 'showdown';
        calculateWinner();
        return;
    }

    // 新阶段开始，从庄家下一位开始说话
    gameState.activeSeat = getNextActiveSeat(gameState.dealerSeat);
    gameState.lastAggressor = gameState.activeSeat; // 重置发起者标记
    
    io.emit('update_state', gameState);
    io.emit('system_msg', `进入阶段: ${gameState.stage}`);
}

function calculateWinner() {
    // (同之前的逻辑，略微优化显示)
    let hands = [];
    gameState.players.forEach(p => {
        if (!p.folded) {
            const solved = Hand.solve(p.hand.concat(gameState.communityCards));
            solved.ownerId = p.id;
            hands.push(solved);
        }
    });
    const winners = Hand.winners(hands);
    
    // 简单的分池逻辑(直接全给赢家)
    let winnerNames = [];
    winners.forEach(w => {
        const p = gameState.players.find(pl => pl.id === w.ownerId);
        p.chips += Math.floor(gameState.pot / winners.length);
        winnerNames.push(`${p.name} (${w.descr})`);
    });

    gameState.pot = 0;
    io.emit('game_over', winnerNames);
    io.emit('update_state', gameState);
}

function finishGame(winner) {
    // 只有一个人没弃牌的情况
    winner.chips += gameState.pot + gameState.players.reduce((acc, p) => acc + p.bet, 0); // 加上当前的下注
    gameState.pot = 0;
    gameState.players.forEach(p => p.bet = 0);
    io.emit('game_over', [`${winner.name} 获胜 (其他人弃牌)`]);
    io.emit('update_state', gameState);
}

// ------------------------------------------
// Socket 交互
// ------------------------------------------
io.on('connection', (socket) => {
    socket.on('join', (name) => {
        gameState.players.push({
            id: socket.id, name, hand: [], chips: 1000, 
            bet: 0, folded: false, hasActed: false 
        });
        io.emit('update_state', gameState);
    });

    socket.on('start_game', () => {
        if (gameState.players.length < 2) return;
        
        // 重置
        gameState.deck = createDeck();
        gameState.communityCards = [];
        gameState.stage = 'preflop';
        gameState.pot = 0;
        
        // 庄家轮换
        gameState.dealerSeat = (gameState.dealerSeat + 1) % gameState.players.length;
        
        // 强制盲注 (简化：庄家下一位小盲10，下下一位大盲20)
        const sbSeat = (gameState.dealerSeat + 1) % gameState.players.length;
        const bbSeat = (gameState.dealerSeat + 2) % gameState.players.length;
        
        gameState.players.forEach((p, i) => {
            p.hand = [gameState.deck.pop(), gameState.deck.pop()];
            p.folded = false;
            p.bet = 0;
            p.hasActed = false;
            
            // 扣盲注
            if (i === sbSeat) { p.bet = 10; p.chips -= 10; }
            if (i === bbSeat) { p.bet = 20; p.chips -= 20; }
        });

        gameState.currentMaxBet = 20; // 大盲是20
        // 大盲下一位开始行动
        gameState.activeSeat = (bbSeat + 1) % gameState.players.length;
        gameState.lastAggressor = gameState.activeSeat; // 用于判断一圈是否结束

        io.emit('update_state', gameState);
        io.emit('system_msg', '游戏开始！盲注已下。');
    });

    socket.on('action', (data) => {
        const { type, amount } = data; // amount 用于加注
        const pIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (pIndex !== gameState.activeSeat) return;
        
        const player = gameState.players[pIndex];
        player.hasActed = true;

        if (type === 'fold') {
            player.folded = true;
            io.emit('system_msg', `${player.name} 弃牌`);
        } 
        else if (type === 'check') {
            // 只有当前下注等于最高下注才能过牌
            if (player.bet < gameState.currentMaxBet) return; // 非法操作
            io.emit('system_msg', `${player.name} 过牌`);
        } 
        else if (type === 'call') {
            const toCall = gameState.currentMaxBet - player.bet;
            if (player.chips < toCall) {
                 // 钱不够，算Allin (简化逻辑，全部压上)
                 player.bet += player.chips;
                 player.chips = 0;
            } else {
                player.chips -= toCall;
                player.bet += toCall;
            }
            io.emit('system_msg', `${player.name} 跟注`);
        } 
        else if (type === 'raise') {
            const raiseAmount = parseInt(amount); // 加注的总额 (比如加注到 100)
            if (raiseAmount <= gameState.currentMaxBet) return; // 必须比现在大
            
            const diff = raiseAmount - player.bet;
            player.chips -= diff;
            player.bet = raiseAmount;
            
            gameState.currentMaxBet = raiseAmount;
            gameState.lastAggressor = pIndex; // 更新发起者，这会让所有人必须重新表态
            
            // 重置其他人的 hasActed状态 (严格德扑规则：有人加注，其他人必须重新决定)
            gameState.players.forEach((p, i) => {
                if (i !== pIndex && !p.folded) p.hasActed = false;
            });

            io.emit('system_msg', `${player.name} 加注到 ${raiseAmount}`);
        }

        // 检查是否应该进入下一阶段，否则切换到下一个人
        if (!checkRoundEnd()) {
            gameState.activeSeat = getNextActiveSeat(gameState.activeSeat);
            io.emit('update_state', gameState);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Running on ${PORT}`));