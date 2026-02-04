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
    activeSeat: 0,
    dealerSeat: 0,
    sbSeat: -1,      // 小盲位置
    bbSeat: -1,      // 大盲位置
    currentMaxBet: 0,
    minRaise: 0,
    bigBlind: 20,
    hostId: null  // 新增: 房主ID
};

// ...existing code... (SUITS, RANKS, createDeck, gameTimer 保持不变)

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

let gameTimer = null;

// ...existing code... (startNewRound, getNextActiveSeat, checkRoundEnd, nextStage, advanceStageLogic, calculateWinner, finishGame 保持不变)

function startNewRound() {
    if (gameTimer) {
        clearTimeout(gameTimer);
        gameTimer = null;
    }

    gameState.players = gameState.players.filter(p => !p.isOffline);

    if (gameState.players.length < 2) {
        gameState.stage = 'waiting';
        io.emit('update_state', gameState);
        io.emit('system_msg', '人数不足，等待玩家加入...');
        return;
    }
    
    gameState.players.forEach(p => {
        if (p.chips <= 0) {
            p.chips = 1000;
            io.emit('system_msg', `玩家 ${p.name} 补充了筹码`);
        }
    });

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.stage = 'preflop';
    gameState.pot = 0;
    
    gameState.dealerSeat = (gameState.dealerSeat + 1) % gameState.players.length;
    
    const n = gameState.players.length;
    let sbSeat, bbSeat;
    if (n === 2) {
        sbSeat = gameState.dealerSeat;
        bbSeat = (gameState.dealerSeat + 1) % n;
    } else {
        sbSeat = (gameState.dealerSeat + 1) % n;
        bbSeat = (gameState.dealerSeat + 2) % n;
    }
    
    // 保存到gameState供前端使用
    gameState.sbSeat = sbSeat;
    gameState.bbSeat = bbSeat;

    const SB_VAL = gameState.bigBlind / 2;
    const BB_VAL = gameState.bigBlind;

    gameState.players.forEach(p => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.folded = false;
        p.bet = 0;
        p.totalHandBet = 0;
        p.hasActed = false;
        p.isWaiting = false;
        p.lastAction = null;  // 记录本轮最后操作: 'fold', 'check', 'call', 'raise', 'allin'
        if(p.solvedHand) delete p.solvedHand;
    });

    const sbPlayer = gameState.players[sbSeat];
    const bbPlayer = gameState.players[bbSeat];

    let actualSB = Math.min(sbPlayer.chips, SB_VAL);
    sbPlayer.chips -= actualSB;
    sbPlayer.bet = actualSB;
    // 注意：totalHandBet 会在 nextStage 时从 bet 累加，这里不要重复设置

    let actualBB = Math.min(bbPlayer.chips, BB_VAL);
    bbPlayer.chips -= actualBB;
    bbPlayer.bet = actualBB;
    // 注意：totalHandBet 会在 nextStage 时从 bet 累加，这里不要重复设置

    // pot 在这里只是用于界面显示，实际归集在 nextStage 进行
    // 为了界面显示当前下注总额，这里设置为 0，让前端动态计算
    gameState.pot = 0;
    gameState.currentMaxBet = actualBB;
    gameState.minRaise = BB_VAL;

    gameState.activeSeat = (bbSeat + 1) % n;
    
    io.emit('update_state', gameState);
    io.emit('system_msg', '=== 新的一局开始 ===');
}

function getNextActiveSeat(currentSeat) {
    let next = currentSeat;
    let count = 0;
    const n = gameState.players.length;
    do {
        next = (next + 1) % n;
        count++;
        const p = gameState.players[next];
        if (!p.folded && p.chips > 0) {
            return next;
        }
    } while (count < n);
    
    return next; 
}

function checkRoundEnd() {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        finishGame(activePlayers[0]);
        return true;
    }

    const allDone = activePlayers.every(p => {
        if (p.chips === 0) return true;
        return p.hasActed && (p.bet === gameState.currentMaxBet);
    });

    if (allDone) {
        nextStage();
        return true;
    }
    return false;
}

function nextStage() {
    gameState.players.forEach(p => {
        gameState.pot += p.bet;
        p.totalHandBet += p.bet;
        p.bet = 0;
        p.hasActed = false;
        p.lastAction = null;  // 重置本轮操作状态
    });
    gameState.currentMaxBet = 0;
    gameState.minRaise = gameState.bigBlind;

    const playersWithChips = gameState.players.filter(p => !p.folded && p.chips > 0).length;
    
    if (playersWithChips < 2) {
        while (gameState.stage !== 'showdown') {
            advanceStageLogic();
            if (gameState.stage === 'showdown') break;
        }
        calculateWinner();
        return;
    }

    advanceStageLogic();

    if (gameState.stage === 'showdown') {
        calculateWinner();
        return;
    }

    const n = gameState.players.length;
    let firstSeat;
    
    if (n === 2) {
        firstSeat = gameState.dealerSeat;
    } else {
        firstSeat = (gameState.dealerSeat + 1) % n;
    }
    
    gameState.activeSeat = getNextActiveSeat((firstSeat + n - 1) % n);
    
    io.emit('update_state', gameState);
}

function advanceStageLogic() {
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
    }
}

function calculateWinner() {
    let activeCandidates = gameState.players.filter(p => !p.folded);
    
    activeCandidates.forEach(p => {
        const fullHand = p.hand.concat(gameState.communityCards);
        p.solvedHand = Hand.solve(fullHand);
    });

    activeCandidates.sort((a, b) => {
        const res = Hand.winners([a.solvedHand, b.solvedHand]);
        if (res.length === 2) return 0;
        return res[0] === a.solvedHand ? -1 : 1; 
    });

    let winnerInfo = [];
    
    gameState.players.forEach(p => {
        if (p.bet > 0) {
            gameState.pot += p.bet;
            p.totalHandBet += p.bet;
            p.bet = 0;
        }
    });

    while (gameState.pot > 0 && activeCandidates.length > 0) {
        let winners = [activeCandidates[0]];
        for (let i = 1; i < activeCandidates.length; i++) {
            const res = Hand.winners([activeCandidates[0].solvedHand, activeCandidates[i].solvedHand]);
            if (res.length === 2) { 
                winners.push(activeCandidates[i]);
            } else {
                break;
            }
        }

        let minWinnerBet = Math.min(...winners.map(w => w.totalHandBet));
        let sidePot = 0;

        gameState.players.forEach(p => {
            const contribution = Math.min(p.totalHandBet, minWinnerBet);
            sidePot += contribution;
            p.totalHandBet -= contribution;
        });
        
        const share = Math.floor(sidePot / winners.length);
        const remainder = sidePot % winners.length;
        
        winners.forEach((w, idx) => {
            w.chips += share + (idx < remainder ? 1 : 0);
            
            if (!winnerInfo.find(i => i.name === w.name)) {
                winnerInfo.push({
                    name: w.name,
                    desc: w.solvedHand.descr,
                    cards: w.solvedHand.cards.map(c => c.toString())
                });
            }
        });
        
        gameState.pot -= sidePot;
        activeCandidates = activeCandidates.filter(p => p.totalHandBet > 0);
    }
    
    gameState.pot = 0;
    io.emit('game_over_details', winnerInfo);
    
    gameState.players.forEach(p => p.totalHandBet = 0);
    io.emit('update_state', gameState);

    io.emit('system_msg', '8秒后自动开始下一局...');
    if (gameTimer) clearTimeout(gameTimer);
    gameTimer = setTimeout(startNewRound, 8000);
}

function finishGame(winner) {
    let currentPot = gameState.pot;
    gameState.players.forEach(p => {
        currentPot += p.bet;
        p.bet = 0;
        p.totalHandBet = 0; 
    });
    
    winner.chips += currentPot;
    gameState.pot = 0;
    
    io.emit('game_over', [`${winner.name} 获胜 (其他人弃牌)`]);
    io.emit('update_state', gameState);

    io.emit('system_msg', '5秒后自动开始下一局...');
    if (gameTimer) clearTimeout(gameTimer);
    gameTimer = setTimeout(startNewRound, 5000);
}

// ------------------------------------------
// Socket 交互
// ------------------------------------------
io.on('connection', (socket) => {
    socket.on('join', (name) => {
        const isFirstPlayer = gameState.players.length === 0;
        const isGameInProgress = gameState.stage !== 'waiting';
        
        gameState.players.push({
            id: socket.id, 
            name, 
            hand: [], 
            chips: 1000, 
            bet: 0, 
            totalHandBet: 0,
            folded: isGameInProgress,  // 游戏进行中加入的玩家标记为已弃牌
            hasActed: false,
            isHost: isFirstPlayer,
            isWaiting: isGameInProgress  // 新增: 标记是否在等待下一局
        });
        
        // 如果是第一个玩家,设为房主
        if (isFirstPlayer) {
            gameState.hostId = socket.id;
            io.emit('system_msg', `${name} 成为房主`);
        }
        
        // 如果游戏正在进行,提示玩家等待
        if (isGameInProgress) {
            socket.emit('system_msg', `游戏进行中，您将在下一局加入`);
            io.emit('system_msg', `${name} 加入房间 (等待下一局)`);
        }
        
        io.emit('update_state', gameState);
    });

    // 聊天功能
    socket.on('chat_msg', (msg) => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;
        
        // 限制消息长度
        const safeMsg = msg.substring(0, 200);
        
        io.emit('chat_msg', {
            name: player.name,
            msg: safeMsg,
            time: new Date().toTimeString().split(' ')[0]
        });
    });

    socket.on('start_game', () => {
        // 只有房主可以开始游戏
        if (socket.id !== gameState.hostId) {
            socket.emit('system_msg', '只有房主可以开始游戏');
            return;
        }
        startNewRound();
    });

    socket.on('action', (data) => {
        const { type } = data; 
        const pIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (pIndex !== gameState.activeSeat) return; 

        const player = gameState.players[pIndex];
        player.hasActed = true;

        if (type === 'fold') {
            player.folded = true;
            player.lastAction = 'fold';
            io.emit('system_msg', `${player.name} 弃牌`);
        } 
        else if (type === 'check') {
            if (player.bet < gameState.currentMaxBet) return;
            player.lastAction = 'check';
            io.emit('system_msg', `${player.name} 过牌`);
        } 
        else if (type === 'call') {
            const gap = gameState.currentMaxBet - player.bet;
            let actualCall = gap;
            
            if (player.chips <= gap) {
                actualCall = player.chips;
                player.lastAction = 'allin';
                io.emit('system_msg', `${player.name} All-in! (${actualCall})`);
            } else {
                player.lastAction = 'call';
                io.emit('system_msg', `${player.name} 跟注 ${actualCall}`);
            }
            
            player.chips -= actualCall;
            player.bet += actualCall;
        } 
        else if (type === 'raise') {
            let amount = parseInt(data.amount);
            
            if (amount < gameState.currentMaxBet + gameState.minRaise) {
                if (player.chips + player.bet < amount) {
                   amount = player.bet + player.chips;
                } else {
                   return;
                }
            }
            
            const raiseDelta = amount - gameState.currentMaxBet;
            const needPay = amount - player.bet;
            
            if (player.chips < needPay) {
                const allInAmt = player.chips + player.bet;
                player.chips = 0;
                player.bet = allInAmt;
                player.lastAction = 'allin';
                
                if (allInAmt > gameState.currentMaxBet) {
                    gameState.currentMaxBet = allInAmt;
                    resetOtherPlayersActed(pIndex);
                }
                io.emit('system_msg', `${player.name} All-in 加注到 ${allInAmt}`);
            } else {
                player.chips -= needPay;
                player.bet = amount;
                player.lastAction = 'raise';
                gameState.currentMaxBet = amount;
                gameState.minRaise = raiseDelta;
                resetOtherPlayersActed(pIndex);
                io.emit('system_msg', `${player.name} 加注到 ${amount}`);
            }
        }

        if (!checkRoundEnd()) {
            gameState.activeSeat = getNextActiveSeat(gameState.activeSeat);
            io.emit('update_state', gameState);
        }
    });

    socket.on('disconnect', () => {
        const pIndex = gameState.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;

        const player = gameState.players[pIndex];
        player.isOffline = true; 
        io.emit('system_msg', `${player.name} 离开了游戏`);

        // 如果房主离开,转移房主给下一个在线玩家
        if (socket.id === gameState.hostId) {
            const nextHost = gameState.players.find(p => !p.isOffline && p.id !== socket.id);
            if (nextHost) {
                gameState.hostId = nextHost.id;
                nextHost.isHost = true;
                player.isHost = false;
                io.emit('system_msg', `${nextHost.name} 成为新房主`);
            } else {
                gameState.hostId = null;
            }
        }

        if (gameState.stage === 'waiting') {
            gameState.players.splice(pIndex, 1);
            io.emit('update_state', gameState);
            return;
        }

        if (!player.folded) {
            player.folded = true;
            
            if (checkRoundEnd()) {
                return;
            }

            if (pIndex === gameState.activeSeat) {
                gameState.activeSeat = getNextActiveSeat(gameState.activeSeat);
                io.emit('update_state', gameState);
            } else {
                io.emit('update_state', gameState);
            }
        }
    });
});

function resetOtherPlayersActed(exceptIndex) {
    gameState.players.forEach((p, i) => {
        if (i !== exceptIndex && !p.folded && p.chips > 0) {
            p.hasActed = false;
        }
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Running on ${PORT}`));