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
    pot: 0,               // 显示用的当前底池(含本轮已下注)
    activeSeat: 0,
    dealerSeat: 0,
    currentMaxBet: 0,     // 本轮最高下注
    minRaise: 0,          // 当前允许的最小加注额(增量)
    bigBlind: 20          // 大盲注数值
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

let gameTimer = null; // 全局定时器引用

// ------------------------------------------
// 核心逻辑
// ------------------------------------------

function startNewRound() {
    // 清除定时器防止重复
    if (gameTimer) {
        clearTimeout(gameTimer);
        gameTimer = null;
    }

    if (gameState.players.length < 2) {
        io.emit('system_msg', '人数不足，等待玩家加入...');
        return;
    }
    
    // 1. 自动买入/补充筹码 (破产保护)
    gameState.players.forEach(p => {
            if (p.chips <= 0) {
                p.chips = 1000;
                io.emit('system_msg', `玩家 ${p.name} 补充了筹码`);
            }
    });

    // 2. 初始化局状态
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.stage = 'preflop';
    gameState.pot = 0;
    
    // 3. 移动 Dealer (Button)
    gameState.dealerSeat = (gameState.dealerSeat + 1) % gameState.players.length;
    
    // 4. 下盲注
    const n = gameState.players.length;
    let sbSeat, bbSeat;
    if (n === 2) {
        sbSeat = gameState.dealerSeat;
        bbSeat = (gameState.dealerSeat + 1) % n;
    } else {
        sbSeat = (gameState.dealerSeat + 1) % n;
        bbSeat = (gameState.dealerSeat + 2) % n;
    }

    const SB_VAL = gameState.bigBlind / 2;
    const BB_VAL = gameState.bigBlind;

    gameState.players.forEach(p => {
        p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        p.folded = false;
        p.bet = 0;
        p.totalHandBet = 0;
        p.hasActed = false;
        // 清理上局遗留的牌力信息(如果有)
        if(p.solvedHand) delete p.solvedHand;
    });

    // 扣盲注逻辑
    const sbPlayer = gameState.players[sbSeat];
    const bbPlayer = gameState.players[bbSeat];

    let actualSB = Math.min(sbPlayer.chips, SB_VAL);
    sbPlayer.chips -= actualSB;
    sbPlayer.bet = actualSB;

    let actualBB = Math.min(bbPlayer.chips, BB_VAL);
    bbPlayer.chips -= actualBB;
    bbPlayer.bet = actualBB;

    gameState.currentMaxBet = BB_VAL; 
    gameState.minRaise = BB_VAL;

    // 5. 确定先手
    gameState.activeSeat = (bbSeat + 1) % n;
    
    io.emit('update_state', gameState);
    io.emit('system_msg', '=== 新的一局开始 ===');
}

// 寻找下一个可行动的玩家
function getNextActiveSeat(currentSeat) {
    let next = currentSeat;
    let count = 0;
    const n = gameState.players.length;
    do {
        next = (next + 1) % n;
        count++;
        const p = gameState.players[next];
        // 玩家必须: 未弃牌 且 还有筹码(未Allin)
        if (!p.folded && p.chips > 0) {
            return next;
        }
    } while (count < n);
    
    // 如果转了一圈没找到(说明其他人都Allin或Fold了)，返回 -1 或做特殊处理
    // 但通常至少有一个人能动，除非所有人都Allin了
    return next; 
}

// 检查本轮是否结束
function checkRoundEnd() {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // 1. 如果只剩1人未弃牌 -> 赢
    if (activePlayers.length === 1) {
        finishGame(activePlayers[0]);
        return true;
    }

    // 2. 检查是否所有人 '已表态' 且 '注额平衡'
    // 注意：All-in 的玩家(chips===0) 不需要满足 bet === currentMaxBet
    const allDone = activePlayers.every(p => {
        if (p.chips === 0) return true; // All-in 玩家视为已完成
        return p.hasActed && (p.bet === gameState.currentMaxBet);
    });

    if (allDone) {
        nextStage();
        return true;
    }
    return false;
}

function nextStage() {
    // 1. 归集本轮筹码
    gameState.players.forEach(p => {
        gameState.pot += p.bet;         // 视觉底池
        p.totalHandBet += p.bet;        // 记录该玩家本局总投入(用于边池计算)
        p.bet = 0;
        p.hasActed = false;
    });
    gameState.currentMaxBet = 0;
    gameState.minRaise = gameState.bigBlind; // 新一轮最小加注重置为大盲

    // 2. 检查是否需要直接跳到摊牌
    // (例如：只有1人或0人持有筹码，其他人全Allin，后续发牌不需要等待操作)
    const playersWithChips = gameState.players.filter(p => !p.folded && p.chips > 0).length;
    
    if (playersWithChips < 2) {
        // 直接并在所有牌，进入结算
        while (gameState.stage !== 'showdown') {
            advanceStageLogic();
            if (gameState.stage === 'showdown') break;
        }
        calculateWinner();
        return;
    }

    // 3. 正常流转
    advanceStageLogic();

    if (gameState.stage === 'showdown') {
        calculateWinner();
        return;
    }

    // 4. 设置先手位 (小盲位或dealer后第一人)
    gameState.activeSeat = getNextActiveSeat(gameState.dealerSeat);
    
    io.emit('update_state', gameState);
}

// 辅助：仅推进阶段和发牌
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
        gameState.stage = 'showdown'; // 标记结束
    }
}

// ------------------------------------------
// 结算逻辑 (支持边池 Side Pots)
// ------------------------------------------
function calculateWinner() {
    let activeCandidates = gameState.players.filter(p => !p.folded);
    
    // 1. 计算所有人的牌力
    activeCandidates.forEach(p => {
        const fullHand = p.hand.concat(gameState.communityCards);
        p.solvedHand = Hand.solve(fullHand); // 挂载到对象上方便后续排序
    });

    // 2. 按牌力排序 (强 -> 弱)
    activeCandidates.sort((a, b) => {
        const res =  Hand.winners([a.solvedHand, b.solvedHand]);
        if (res.length === 2) return 0; // 平手
        return res[0] === a.solvedHand ? -1 : 1; 
    });

    // 3. 分池算法 (Iterative Pot Distribution)
    let winnerInfo = [];
    
    // 收集所有投入到底池的钱 (此前 nextStage 已经把 bet 归入 totalHandBet)
    // 但如果是 Showdown 触发的，还需要把当前轮的 bet 加进去
    gameState.players.forEach(p => {
         // 确保最后一点筹码算入总投入
         if (p.bet > 0) {
             gameState.pot += p.bet;
             p.totalHandBet += p.bet;
             p.bet = 0;
         }
    });

    while (gameState.pot > 0 && activeCandidates.length > 0) {
        // 取出当前最强的一批人 (可能有平局)
        let winners = [activeCandidates[0]];
        for (let i = 1; i < activeCandidates.length; i++) {
            const res = Hand.winners([activeCandidates[0].solvedHand, activeCandidates[i].solvedHand]);
            if (res.length === 2) { 
                winners.push(activeCandidates[i]);
            } else {
                break; // 后面都比第一名弱
            }
        }

        // 计算这批赢家能赢多少钱
        // 原则：赢家赢取的钱 = 所有玩家(含已Fold)贡献中，不超过(赢家自己贡献额)的部分
        // 如果有多个平局赢家，找出他们中贡献最小的那个 amount，作为本轮分配的基准
        
        let minWinnerBet = Math.min(...winners.map(w => w.totalHandBet));
        let sidePot = 0;

        gameState.players.forEach(p => {
            const contribution = Math.min(p.totalHandBet, minWinnerBet);
            sidePot += contribution;
            p.totalHandBet -= contribution; // 扣除已结算部分
        });
        
        // 分配 sidePot 给 winners
        const share = Math.floor(sidePot / winners.length);
        winners.forEach(w => {
            w.chips += share;
            // 记录赢钱信息(去重)
            if (!winnerInfo.find(i => i.name === w.name)) {
                winnerInfo.push({
                    name: w.name,
                    desc: w.solvedHand.descr,
                    cards: w.solvedHand.cards.map(c => c.toString()) // 高亮牌
                });
            }
        });
        
        gameState.pot -= sidePot;

        // 移除已经分完钱且没有剩余投入的赢家
        // 只有 totalHandBet > 0 的人才能继续争夺剩余 Pot
        activeCandidates = activeCandidates.filter(p => p.totalHandBet > 0);
    }
    
    gameState.pot = 0;
    io.emit('game_over_details', winnerInfo);
    
    // 重置所有人的 totalHandBet 防止污染下一局
    gameState.players.forEach(p => p.totalHandBet = 0);
    io.emit('update_state', gameState);

    // 自动开始下一局
    io.emit('system_msg', '8秒后自动开始下一局...');
    if (gameTimer) clearTimeout(gameTimer);
    gameTimer = setTimeout(startNewRound, 8000);
}

// 唯一幸存者胜利
function finishGame(winner) {
    // 把底池加所有当下注额都给赢家
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

    // 自动开始下一局
    io.emit('system_msg', '5秒后自动开始下一局...');
    if (gameTimer) clearTimeout(gameTimer);
    gameTimer = setTimeout(startNewRound, 5000);
}


// ------------------------------------------
// Socket 交互
// ------------------------------------------
io.on('connection', (socket) => {
    socket.on('join', (name) => {
        gameState.players.push({
            id: socket.id, 
            name, 
            hand: [], 
            chips: 1000, 
            bet: 0, 
            totalHandBet: 0, // 新增：本局总投入
            folded: false, 
            hasActed: false 
        });
        io.emit('update_state', gameState);
    });

    socket.on('start_game', () => {
        // 手动触发挥发全部使用新逻辑
        startNewRound();
    });

    socket.on('action', (data) => {
        const { type } = data; 
        const pIndex = gameState.players.findIndex(p => p.id === socket.id);
        // 校验是否轮到该玩家
        if (pIndex !== gameState.activeSeat) return; 

        const player = gameState.players[pIndex];
        player.hasActed = true;

        if (type === 'fold') {
            player.folded = true;
            io.emit('system_msg', `${player.name} 弃牌`);
        } 
        else if (type === 'check') {
            if (player.bet < gameState.currentMaxBet) return; // 必须平注才能 check
            io.emit('system_msg', `${player.name} 过牌`);
        } 
        else if (type === 'call') {
            const gap = gameState.currentMaxBet - player.bet;
            let actualCall = gap;
            
            // All-in 逻辑
            if (player.chips <= gap) {
                actualCall = player.chips;
                io.emit('system_msg', `${player.name} All-in! (${actualCall})`);
            } else {
                io.emit('system_msg', `${player.name} 跟注`);
            }
            
            player.chips -= actualCall;
            player.bet += actualCall;
        } 
        else if (type === 'raise') {
            let amount = parseInt(data.amount); // 目标 total bet
            
            // 校验加注合法性
            // 规则: 加注后的总量 >= currentMaxBet + minRaise
            if (amount < gameState.currentMaxBet + gameState.minRaise) {
                // 如果玩家想All-in且钱不够最小加注，算All-in (视为Call/Raise)
                if (player.chips + player.bet < amount) {
                   amount = player.bet + player.chips;
                } else {
                   return; // 非法加注
                }
            }
            
            // 计算这次真正加了多少 (Raise Delta)
            const raiseDelta = amount - gameState.currentMaxBet;
            
            // 扣钱
            const needPay = amount - player.bet;
            if (player.chips < needPay) {
                // 钱不够，变成 All-in
                const allInAmt = player.chips + player.bet;
                player.chips = 0;
                player.bet = allInAmt;
                
                // 如果 All-in 的额度触发了 Raise...
                if (allInAmt > gameState.currentMaxBet) {
                    gameState.currentMaxBet = allInAmt;
                    
                    // 这里简化：只要比当前大，就算Raise
                    resetOtherPlayersActed(pIndex);
                }
                io.emit('system_msg', `${player.name} All-in 加注到 ${allInAmt}`);
            } else {
                // 正常加注
                player.chips -= needPay;
                player.bet = amount;

                gameState.currentMaxBet = amount;
                gameState.minRaise = raiseDelta; // 更新最小加注额为本次增量
                
                resetOtherPlayersActed(pIndex);
                io.emit('system_msg', `${player.name} 加注到 ${amount}`);
            }
        }

        if (!checkRoundEnd()) {
            gameState.activeSeat = getNextActiveSeat(gameState.activeSeat);
            io.emit('update_state', gameState);
        }
    });
});

function resetOtherPlayersActed(exceptIndex) {
    gameState.players.forEach((p, i) => {
        if (i !== exceptIndex && !p.folded && p.chips > 0) {
            p.hasActed = false; // 别人加注了，你得重新表态
        }
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Running on ${PORT}`));
