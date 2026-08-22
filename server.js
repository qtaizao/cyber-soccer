const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(express.static(__dirname));

const http = axios.create({ timeout: 12000 });

const MODEL_CONFIG = {
    deepseek: {
        label: 'DeepSeek',
        enabled: Boolean(process.env.DEEPSEEK_API_KEY),
        url: 'https://api.deepseek.com/chat/completions',
        key: process.env.DEEPSEEK_API_KEY,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
    },
    chatgpt: {
        label: 'ChatGPT',
        enabled: Boolean(process.env.OPENAI_API_KEY),
        url: 'https://api.openai.com/v1/chat/completions',
        key: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },
    marketBase: {
        label: '赔率泊松基准',
        enabled: true
    }
};

const LEAGUE_PREFIX_RE = /^(?:竞彩足球|竞彩|北京单场|北单|胜平负|让球胜平负|英超|英冠|英甲|英乙|西甲|西乙|意甲|意乙|德甲|德乙|法甲|法乙|葡超|荷甲|比甲|瑞超|挪超|丹超|芬超|奥甲|苏超|欧冠|欧联|欧协联|欧洲杯|世预赛|世欧预|世南美预|亚洲杯|亚冠|亚冠精英|亚冠二级|日职联|日职乙|日职|日乙|日联杯|韩职|韩K联|澳超|美职足|美公开赛|巴甲|阿甲|墨超|中超|中甲|足协杯|解放者杯|南俱杯|世俱杯|国际赛|友谊赛)\s*/;

app.get('/api/matches/source-new', async (req, res) => {
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto('https://xx.spftll.cn/#/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const rawMatches = await page.evaluate(() => {
            const list = [];
            document.querySelectorAll('div, span, p').forEach(n => {
                const txt = n.innerText.trim();
                if (txt.includes('VS') && (txt.includes('胜') || txt.includes('让')) && txt.length > 15 && txt.length < 250) {
                    list.push(txt);
                }
            });
            return list;
        });
        await browser.close();

        const matchMap = new Map();
        rawMatches.forEach(item => {
            const vsMatch = item.match(/([^\s]+)\s+(?:VS|vs)\s+([^\s]+)/);
            if (!vsMatch) return;
            const teamKey = (vsMatch[1] + vsMatch[2]).toLowerCase();
            if (!matchMap.has(teamKey)) matchMap.set(teamKey, item);
        });

        res.json({ success: true, matchList: Array.from(matchMap.values()).map(raw => ({ raw })) });
    } catch (e) {
        if (browser) await browser.close();
        res.status(500).json({ success: false, message: e.message || '抓取失败' });
    }
});

app.get('/api/matches/beidan', async (req, res) => {
    const urls = [
        'https://xx.spftll.cn/#/jc/dpfas1/?tabindex=2',
        'https://www.sporttery.cn/jc/zqdc/',
        'https://www.sporttery.cn/bjdc/',
        'https://www.sporttery.cn/bd/',
        'https://live.500star.com/zqdc.php',
        'http://live.500star.com/zqdc.php'
    ];
    let browser = null;
    const errors = [];
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');

        for (const url of urls) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, url.includes('xx.spftll.cn') ? 5000 : 3500));
                const rawMatches = await page.evaluate(() => {
                    const rows = [];
                    document.querySelectorAll('tr, li, div, span, p').forEach(n => {
                        const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
                        if ((txt.includes('VS') || txt.includes('vs') || /北单|北京单场|胜平负|让球/.test(txt)) && /\b\d+\.\d{2}\b/.test(txt) && txt.length > 15 && txt.length < 320) {
                            rows.push(txt);
                        }
                    });
                    return rows;
                });
                const parsed = url.includes('live.500star.com') ? parse500LiveRows(rawMatches) : normalizeRawMatchList(rawMatches, 'bd');
                if (parsed.length) {
                    await browser.close();
                    return res.json({ success: true, source: url, matchList: parsed });
                }
                errors.push(`${url}: 未识别到北单盘口行`);
            } catch (e) {
                errors.push(`${url}: ${e.message}`);
            }
        }

        const backup = await fetch500StarBeidan();
        if (backup.length) {
            await browser.close();
            return res.json({ success: true, source: 'https://zx.500star.com/zqdc/shuju.php', matchList: backup });
        }
        errors.push('500彩票网赛事数据页: 未解析到可用表格行');

        await browser.close();
        res.json({ success: false, matchList: [], message: `北单数据源未返回可解析盘口：${errors.join('；')}` });
    } catch (e) {
        if (browser) await browser.close();
        res.status(500).json({ success: false, matchList: [], message: e.message || '北单抓取失败' });
    }
});

async function fetch500StarBeidan() {
    try {
        const r = await http.get('https://zx.500star.com/zqdc/shuju.php', {
            responseType: 'text',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36' }
        });
        return parse500StarBeidanHtml(String(r.data || ''));
    } catch (e) {
        return [];
    }
}

function parse500StarBeidanHtml(html) {
    const rows = [...String(html || '').matchAll(/<tr[\s\S]*?<\/tr>/gi)];
    const list = [];
    rows.forEach((row, index) => {
        const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        if (cells.length < 10) return;
        const timeCellIndex = cells.findIndex(c => /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(c));
        if (timeCellIndex < 0) return;
        const league = cells[timeCellIndex - 1] || '北单';
        const matchTime = cells[timeCellIndex].replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
        const home = cells[timeCellIndex + 1];
        const rangNum = normalizeRangNumForServer(cells[timeCellIndex + 2]);
        const away = cells[timeCellIndex + 3];
        const odds = cells.slice(timeCellIndex + 4).filter(c => /^\d+\.\d{2}$/.test(c));
        if (!home || !away || odds.length < 3) return;
        list.push({
            raw: `${league} 北单${String(index + 1).padStart(3, '0')} ${matchTime} ${home} VS ${away} 让球 ${rangNum} ${odds.slice(-3).join(' ')}`,
            code: `北单${String(list.length + 1).padStart(3, '0')}`,
            matchName: `${home} VS ${away}`,
            matchTime,
            s: odds.slice(-3)[0],
            p: odds.slice(-3)[1],
            f: odds.slice(-3)[2],
            hasRang: rangNum !== '--',
            rangNum,
            rs: '--',
            rp: '--',
            rf: '--'
        });
    });
    return list;
}

function normalizeRangNumForServer(value) {
    const n = parseInt(String(value || '').replace(/[＋+]/g, ''), 10);
    if (!Number.isFinite(n)) return '--';
    return n > 0 ? `+${n}` : String(n);
}

function normalizeRawMatchList(rawMatches, mode) {
    const map = new Map();
    rawMatches.forEach((raw, index) => {
        const parsed = parseRawOddsText(raw, mode, index + 1);
        if (!parsed.matchName || !/\sVS\s/.test(parsed.matchName)) return;
        const key = parsed.matchName.replace(/\s+/g, '').toLowerCase();
        const existing = map.get(key);
        if (!existing || String(parsed.raw).length > String(existing.raw).length) map.set(key, parsed);
    });
    return [...map.values()];
}

function parse500LiveRows(rawMatches) {
    const list = [];
    rawMatches.forEach(raw => {
        const text = String(raw || '').replace(/\s+/g, ' ').trim();
        const odds = text.match(/\b\d+\.\d{2}\b/g) || [];
        const m = text.match(/^(\d+)\s+(\S+)\s+(?:第\S+\s+)?(\d{2}-\d{2}\s+\d{2}:\d{2})\s+\S+\s+(.+?)\s+-\s+(.+?)\s+-\s+/);
        if (!m || odds.length < 3) return;
        const home = cleanLiveTeamName(m[4]);
        const away = cleanLiveTeamName(m[5]);
        const rangInfo = parseRangInfo(`${home} ${away}`);
        const lastOdds = odds.slice(-3);
        list.push({
            raw: `${m[2]} 北单${m[1]} ${m[3]} ${home} VS ${away} 让球 ${rangInfo.rangNum} ${lastOdds.join(' ')}`,
            code: `北单${m[1]}`,
            matchName: `${cleanLiveTeamName(home, true)} VS ${cleanLiveTeamName(away, true)}`,
            matchTime: m[3],
            s: lastOdds[0],
            p: lastOdds[1],
            f: lastOdds[2],
            hasRang: rangInfo.hasRang,
            rangNum: rangInfo.rangNum,
            rs: '--',
            rp: '--',
            rf: '--'
        });
    });
    return list;
}

function cleanLiveTeamName(value, dropRang = false) {
    let text = String(value || '').replace(/\[[^\]]+]/g, '').trim();
    if (dropRang) text = text.replace(/\([+-]\d+\)/g, '').trim();
    return text;
}

function parseRawOddsText(rawText, mode = 'jc', index = 1) {
    const raw = String(rawText || '').replace(/\s+/g, ' ').trim();
    const odds = raw.match(/\b\d+\.\d{2}\b/g) || [];
    const timeMatch = raw.match(/(?:周[一-日]\s*\d{2}:\d{2})|(?:\d{2}:\d{2})/);
    const codeMatch = raw.match(/((?:周[一-日]\d+)|(?:北单\d+)|(?:\d{3}))/);
    const bdCodeMatch = mode === 'bd' ? raw.match(/(?:^|\s)(\d{1,3})(?=\s+\d{2}:\d{2})/) : null;
    const rangInfo = parseRangInfo(raw);
    return {
        raw,
        league: extractLeagueNameFromRaw(raw),
        code: normalizeMatchCode(codeMatch ? codeMatch[1] : (bdCodeMatch ? bdCodeMatch[1] : (mode === 'bd' ? `北单${String(index).padStart(3, '0')}` : `JC${String(index).padStart(3, '0')}`)), mode),
        matchName: cleanRawMatchName(raw, timeMatch?.[0]),
        matchTime: timeMatch?.[0] || '今日 20:00',
        s: odds[0] || '2.00',
        p: odds[1] || '3.00',
        f: odds[2] || '3.00',
        hasRang: odds.length >= 6 || rangInfo.hasRang,
        rangNum: rangInfo.rangNum,
        rs: odds[3] || '--',
        rp: odds[4] || '--',
        rf: odds[5] || '--'
    };
}

function extractLeagueNameFromRaw(rawText) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    const structured = text.match(/^(.+?)\s+(?:周[一-日]\d+|北单\d+|\d{1,3})\s+\d{1,2}:\d{2}\b/);
    const beforeCode = structured || text.match(/^(.+?)\s+(?:周[一-日]\d+|北单\d+|\d{1,3})\b/);
    const value = beforeCode ? beforeCode[1] : text.split(/\s+/)[0];
    return normalizeLeagueName(value);
}

function normalizeLeagueName(value) {
    const text = String(value || '')
        .replace(/竞彩足球|竞彩|北京单场|北单|胜平负|让球胜平负/g, '')
        .replace(/\d{1,3}$/g, '')
        .trim();
    if (!text || /^(?:周[一-日]\d+|北单\d+|\d{1,3}|\d{1,2}:\d{2})$/.test(text)) return '其他';
    return text;
}

function parseRangInfo(rawText) {
    const text = String(rawText || '').replace(/\s+/g, ' ');
    const cnNumber = '[一二两三四五六七八九十]';
    const candidates = [
        [/([+-]?\d)(?=\s*(?:让胜|让平|让负|让主胜|让客胜))/, 0],
        [/(?:VS|vs).+?\s([+-]?\d)(?=\s*(?:让胜|让平|让负|让主胜|让客胜))/, 0],
        [/\(([+-]\d+)\)/, 0],
        [new RegExp(`受让\\s*(${cnNumber})`), 1, true],
        [/受让\s*([+＋]?\d+)/, 1],
        [/(?:让球胜平负|让球|让)\s*([+＋]\d+)/, 1],
        [new RegExp(`(?:让球胜平负|让球|让)\\s*[-－]\\s*(${cnNumber})`), -1, true],
        [new RegExp(`(?:让球胜平负|让球|让)\\s*(${cnNumber})`), -1, true],
        [/(?:让球胜平负|让球|让)\s*(\d+)/, -1],
        [/(?:VS|vs).+?\s(0)(?=\s*胜)/, 0],
        [/(?:^|\s)([+-]\d)(?=\s|胜|平|负|$)/, 0]
    ];
    for (const [re, sign, isChinese] of candidates) {
        const m = text.match(re);
        if (!m) continue;
        const n = isChinese ? chineseHandicapToNumber(m[1]) : parseInt(String(m[1]).replace(/[＋+]/g, ''), 10);
        if (!Number.isFinite(n)) continue;
        const value = sign === 0 ? n : sign * Math.abs(n);
        return { hasRang: true, rangNum: value > 0 ? `+${value}` : String(value) };
    }
    return { hasRang: false, rangNum: '--' };
}

function normalizeMatchCode(code, mode) {
    const text = String(code || '').trim();
    if (mode === 'bd') {
        const digits = text.match(/\d+/)?.[0];
        return digits ? `北单${digits.padStart(3, '0')}` : text;
    }
    return text;
}

function chineseHandicapToNumber(value) {
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return map[String(value || '').trim()];
}

function cleanRawMatchName(rawText, timeTag) {
    let name = String(rawText || '');
    if (timeTag) name = name.replace(timeTag, '');
    name = name
        .replace(/((?:周[一-日]\d+)|(?:北单\d+)|(?:JC\d+)|(?:\d{3}))/g, '')
        .replace(/(^|\s)\d{1,2}(?=\s)/g, ' ')
        .replace(/单|胆/g, '')
        .split(/(?:胜平负|让球胜平负|让球|主胜|客胜|让主胜|让客胜|让平|胜|平|负)/)[0]
        .replace(/\b\d+\.\d{2}\b/g, '')
        .replace(/(?:让|受让)\s*(?:负|[-－+＋])?\s*\d+/g, '')
        .replace(/\s*[+-]?\d+\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const vs = name.match(/(.+?)\s*(?:VS|vs|V|v|对)\s*(.+)/);
    if (!vs) return cleanTeamName(name);
    return `${cleanTeamName(vs[1])} VS ${cleanTeamName(vs[2])}`;
}

app.post('/api/ai/predict-consensus', async (req, res) => {
    try {
        const { oddsInfo = {}, factors = {}, contextData = {}, apiKeys = {}, useDeepSeek, useChatGPT, useMarketBase, useBagua } = req.body;
        const match = normalizeMatch(oddsInfo);
        const intelligence = await collectIntelligence(match, { ...contextData, ...factors });
        const market = analyzeMarket(match, intelligence);
        const models = await runSelectedModels({ match, intelligence, market, apiKeys }, { useDeepSeek, useChatGPT, useMarketBase });
        const modelScores = models.filter(m => m.score).map(m => m.score);
        const aiModelConsensusScore = consensusScore(modelScores, market.scoreMatrix);
        const bagua = useBagua ? calculateMeihuaYishu(match) : disabledBlock('梅花易数', '未启用');
        const completeness = calculateCompleteness(intelligence, models);

        res.json({
            success: true,
            data: {
                capitalIntent: market.capitalIntent,
                market,
                capitalDesiredScore: market.capitalDesiredScore,
                capitalReason: market.capitalReason,
                aiModelConsensusScore,
                aiReason: buildAiReason(intelligence, market, models, aiModelConsensusScore),
                deepseek: formatModelBlock(models, 'deepseek'),
                chatgpt: formatModelBlock(models, 'chatgpt'),
                marketBase: formatModelBlock(models, 'marketBase'),
                gemini: disabledBlock('Gemini', '已关闭网页免费入口模拟；如需真实 API，可配置 GEMINI_API_KEY 后再接入。'),
                doubao: disabledBlock('豆包', '已关闭网页免费入口模拟；如需真实 API，可配置火山方舟接入点后再接入。'),
                bagua,
                confidence: `${completeness.confidence}%`,
                dataQuality: completeness,
                intelligence
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || '预测服务异常' });
    }
});

app.post('/api/ai/review-ai-result', async (req, res) => {
    try {
        const { oddsInfo = {}, factors = {}, contextData = {}, aiText = '' } = req.body;
        const match = normalizeMatch(oddsInfo);
        const intelligence = await collectIntelligence(match, { ...contextData, ...factors });
        const market = analyzeMarket(match, intelligence);
        const review = reviewPastedAiText(aiText, market);
        res.json({
            success: true,
            data: {
                match,
                market,
                intelligence,
                review
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || '复盘服务异常' });
    }
});

function normalizeMatch(oddsInfo) {
    const teams = parseTeams(oddsInfo.matchName || oddsInfo.name || '');
    return {
        code: oddsInfo.code || '001',
        matchName: oddsInfo.matchName || '未知赛事',
        homeTeam: oddsInfo.homeTeam || teams.homeTeam || '主队',
        awayTeam: oddsInfo.awayTeam || teams.awayTeam || '客队',
        matchTime: oddsInfo.matchTime || '今日 20:00',
        s: safeOdd(oddsInfo.s, 2),
        p: safeOdd(oddsInfo.p, 3),
        f: safeOdd(oddsInfo.f, 3),
        rangNum: oddsInfo.rangNum || '0',
        venueCity: oddsInfo.venueCity || oddsInfo.city || ''
    };
}

function parseTeams(matchName) {
    const clean = String(matchName)
        .replace(/\[[^\]]+]/g, '')
        .replace(/开赛:.*/g, '')
        .replace(/(?:让|受让)\s*(?:负|[-－+])?\s*\d+/g, '')
        .replace(/\b\d+\.\d{2}\b/g, '')
        .replace(/\s*[+-]?\d+\s*$/g, '')
        .trim();
    const m = clean.match(/(.+?)\s*(?:VS|vs|V|v|对|vs\.)\s*(.+)/);
    if (!m) return {};
    return { homeTeam: cleanTeamName(m[1]), awayTeam: cleanTeamName(m[2]) };
}

function cleanTeamName(name) {
    return stripLeaguePrefix(String(name || ''))
        .replace(/^(?:周[一-日]\d+|北单\d+|JC\d+|\d{3})\s*/g, '')
        .replace(/^[\u4e00-\u9fa5A-Za-z]{2,10}\s+\d{1,3}\s+/, '')
        .replace(/^[\u4e00-\u9fa5A-Za-z]{2,10}\s+(?=[^\s]+$)/, '')
        .replace(/(?:胜平负|让球胜平负|让球|主胜|客胜|让主胜|让客胜|让平|胜|平|负).*/g, '')
        .replace(/\s*[+-]?\d+\s*$/g, '')
        .trim();
}

function stripLeaguePrefix(value) {
    let text = String(value || '').trim();
    for (let i = 0; i < 3; i++) {
        const next = text.replace(LEAGUE_PREFIX_RE, '').trim();
        if (next === text) break;
        text = next;
    }
    return text;
}

function safeOdd(value, fallback) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 1 ? n : fallback;
}

async function collectIntelligence(match, manual) {
    const items = [];
    const city = manual.venueCity || match.venueCity || inferCity(match.homeTeam);
    const [weather, publicData] = await Promise.all([
        fetchWeather(city),
        fetchPublicFootballData(match)
    ]);
    items.push(weather);
    items.push(...publicData.items);

    addManualIntelligence(items, '天气场地', manual.weather);
    addManualIntelligence(items, '伤停', manual.injuries);
    addManualIntelligence(items, '阵型', manual.formation);
    addManualIntelligence(items, '战意/情绪', manual.psychology);
    addManualIntelligence(items, '历史交锋', manual.h2hRecord || manual.h2h);
    addManualIntelligence(items, '近期战绩', manual.recentForm);
    addManualIntelligence(items, '未来赛程', manual.futureSchedule);

    return {
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        venueCity: city || '',
        publicData: publicData.summary,
        items,
        verified: items.filter(i => i.status === 'verified'),
        manual: items.filter(i => i.status === 'manual'),
        missing: items.filter(i => i.status === 'missing')
    };
}

function inferCity(team) {
    const known = [
        ['北京', '北京'], ['上海', '上海'], ['广州', '广州'], ['深圳', '深圳'], ['成都', '成都'],
        ['武汉', '武汉'], ['天津', '天津'], ['青岛', '青岛'], ['南京', '南京'], ['杭州', '杭州'],
        ['大连', '大连'], ['长春', '长春'], ['西安', '西安'], ['重庆', '重庆'],
        ['阿森纳', 'London'], ['切尔西', 'London'], ['热刺', 'London'], ['曼城', 'Manchester'],
        ['曼联', 'Manchester'], ['利物浦', 'Liverpool'], ['埃弗顿', 'Liverpool'], ['纽卡斯尔', 'Newcastle upon Tyne'],
        ['皇马', 'Madrid'], ['皇家马德里', 'Madrid'], ['马竞', 'Madrid'], ['马德里竞技', 'Madrid'],
        ['巴萨', 'Barcelona'], ['巴塞罗那', 'Barcelona'], ['拜仁', 'Munich'], ['多特蒙德', 'Dortmund'],
        ['尤文', 'Turin'], ['尤文图斯', 'Turin'], ['国际米兰', 'Milan'], ['AC米兰', 'Milan'],
        ['罗马', 'Rome'], ['那不勒斯', 'Naples'], ['巴黎圣日耳曼', 'Paris'], ['巴黎', 'Paris'],
        ['柏太阳神', 'Kashiwa'], ['长崎航海', 'Nagasaki'], ['长崎成功丸', 'Nagasaki'],
        ['浦和红钻', 'Saitama'], ['鹿岛鹿角', 'Kashima'], ['川崎前锋', 'Kawasaki'],
        ['横滨水手', 'Yokohama'], ['横滨FC', 'Yokohama'], ['大阪钢巴', 'Osaka'],
        ['大阪樱花', 'Osaka'], ['神户胜利船', 'Kobe'], ['名古屋鲸八', 'Nagoya'],
        ['广岛三箭', 'Hiroshima'], ['东京FC', 'Tokyo'], ['町田泽维亚', 'Machida'], ['町田泽维', 'Machida'],
        ['福冈黄蜂', 'Fukuoka'], ['札幌冈萨多', 'Sapporo'], ['新潟天鹅', 'Niigata'],
        ['京都不死鸟', 'Kyoto'], ['湘南海洋', 'Hiratsuka'], ['鸟栖砂岩', 'Tosu'],
        ['冈山绿雉', 'Okayama'], ['仙台七夕', 'Sendai'], ['千叶市原', 'Chiba'],
        ['山形山神', 'Yamagata'], ['德岛漩涡', 'Tokushima'], ['甲府风林', 'Kofu'],
        ['水户蜀葵', 'Mito'], ['藤枝MYFC', 'Fujieda'], ['熊本深红', 'Kumamoto'],
        ['大分三神', 'Oita'], ['山口雷法', 'Yamaguchi'], ['秋田蓝闪电', 'Akita'],
        ['群马草津温泉', 'Maebashi'], ['枥木SC', 'Utsunomiya'], ['爱媛FC', 'Matsuyama']
    ];
    const hit = known.find(([key]) => String(team).includes(key));
    return hit ? hit[1] : '';
}

async function fetchPublicFootballData(match) {
    const summary = {
        source: 'TheSportsDB 免费公开接口',
        homeResolved: '',
        awayResolved: '',
        notes: []
    };
    const items = [];
    try {
        const [home, away] = await Promise.all([
            searchPublicTeam(match.homeTeam),
            searchPublicTeam(match.awayTeam)
        ]);
        summary.homeResolved = home?.strTeam || '';
        summary.awayResolved = away?.strTeam || '';

        if (!home || !away) {
            const missing = [
                !home ? `主队 ${match.homeTeam}，候选 ${buildTeamSearchCandidates(match.homeTeam).join('/')}` : '',
                !away ? `客队 ${match.awayTeam}，候选 ${buildTeamSearchCandidates(match.awayTeam).join('/')}` : ''
            ].filter(Boolean).join('；');
            items.push(missingItem('公开球队数据', `未能匹配球队：${missing}`));
            return { items, summary };
        }

        const [homeLast, awayLast, homeNext, awayNext] = await Promise.all([
            fetchLastEvents(home.idTeam),
            fetchLastEvents(away.idTeam),
            fetchNextEvents(home.idTeam),
            fetchNextEvents(away.idTeam)
        ]);

        const homeForm = summarizeRecentForm('主队', homeLast, home.strTeam);
        const awayForm = summarizeRecentForm('客队', awayLast, away.strTeam);
        items.push(verifiedItem('近期战绩', `${homeForm}；${awayForm}`, summary.source));

        const schedule = summarizeSchedule(home.strTeam, homeNext, away.strTeam, awayNext);
        items.push(verifiedItem('未来赛程', schedule, summary.source));

        const h2h = summarizeH2H(home.strTeam, away.strTeam, homeLast, awayLast);
        items.push(h2h ? verifiedItem('历史交锋', h2h, summary.source) : missingItem('历史交锋', '公开接口未在近期赛事中找到双方直接交锋。'));

        const motivation = inferMotivationFromSchedule(match, homeNext, awayNext);
        items.push(verifiedItem('战意/赛程推断', motivation, '赔率 + 公开赛程规则'));

        summary.notes.push('公开数据源主要覆盖英文/欧洲球队；中文队名命中率取决于接口别名。');
        return { items, summary };
    } catch (e) {
        items.push(missingItem('公开赛事数据', `公开数据查询失败：${e.message}`));
        return { items, summary };
    }
}

async function searchPublicTeam(teamName) {
    const candidates = buildTeamSearchCandidates(teamName);
    for (const name of candidates) {
        try {
            const r = await http.get('https://www.thesportsdb.com/api/v1/json/3/searchteams.php', { params: { t: name } });
            const teams = r.data?.teams || [];
            const footballTeam = teams.find(t => /Soccer/i.test(t.strSport || '')) || teams[0];
            if (footballTeam?.idTeam) return footballTeam;
        } catch (e) {
            continue;
        }
    }
    return null;
}

function buildTeamSearchCandidates(teamName) {
    const raw = cleanTeamName(teamName);
    const map = {
        '阿森纳': 'Arsenal', '切尔西': 'Chelsea', '曼城': 'Manchester City', '曼联': 'Manchester United',
        '利物浦': 'Liverpool', '热刺': 'Tottenham Hotspur', '皇马': 'Real Madrid', '皇家马德里': 'Real Madrid',
        '巴萨': 'Barcelona', '巴塞罗那': 'Barcelona', '马竞': 'Atletico Madrid', '马德里竞技': 'Atletico Madrid',
        '拜仁': 'Bayern Munich', '拜仁慕尼黑': 'Bayern Munich', '多特蒙德': 'Borussia Dortmund',
        '尤文': 'Juventus', '尤文图斯': 'Juventus',
        '国际米兰': 'Inter Milan', 'AC米兰': 'AC Milan', '罗马': 'Roma', '那不勒斯': 'Napoli', '巴黎': 'Paris Saint-Germain',
        '巴黎圣日耳曼': 'Paris Saint-Germain',
        '柏太阳神': 'Kashiwa Reysol', '长崎航海': 'V Varen Nagasaki', '长崎成功丸': 'V Varen Nagasaki',
        '浦和红钻': 'Urawa Red Diamonds', '鹿岛鹿角': 'Kashima Antlers', '川崎前锋': 'Kawasaki Frontale',
        '横滨水手': 'Yokohama F. Marinos', '横滨FC': 'Yokohama FC', '大阪钢巴': 'Gamba Osaka',
        '大阪樱花': 'Cerezo Osaka', '神户胜利船': 'Vissel Kobe', '名古屋鲸八': 'Nagoya Grampus',
        '广岛三箭': 'Sanfrecce Hiroshima', '东京FC': 'FC Tokyo', '町田泽维亚': 'Machida Zelvia', '町田泽维': 'Machida Zelvia',
        '福冈黄蜂': 'Avispa Fukuoka', '札幌冈萨多': 'Hokkaido Consadole Sapporo',
        '新潟天鹅': 'Albirex Niigata', '京都不死鸟': 'Kyoto Sanga', '湘南海洋': 'Shonan Bellmare',
        '鸟栖砂岩': 'Sagan Tosu', '磐田喜悦': 'Jubilo Iwata', '清水鼓动': 'Shimizu S-Pulse',
        '冈山绿雉': 'Fagiano Okayama', '仙台七夕': 'Vegalta Sendai', '千叶市原': 'JEF United Chiba',
        '山形山神': 'Montedio Yamagata', '德岛漩涡': 'Tokushima Vortis', '甲府风林': 'Ventforet Kofu',
        '水户蜀葵': 'Mito HollyHock', '藤枝MYFC': 'Fujieda MYFC', '熊本深红': 'Roasso Kumamoto',
        '大分三神': 'Oita Trinita', '山口雷法': 'Renofa Yamaguchi', '秋田蓝闪电': 'Blaublitz Akita',
        '群马草津温泉': 'Thespa Gunma', '枥木SC': 'Tochigi SC', '爱媛FC': 'Ehime FC'
    };
    const cleaned = raw.replace(/\(.+?\)|（.+?）/g, '').replace(/足球俱乐部|俱乐部|队/g, '').trim();
    const mapped = map[raw] || map[cleaned];
    const variants = mapped ? [mapped, mapped.replace(/\s/g, '-'), mapped.replace(/-/g, ' '), mapped.replace(/^V\s/, 'V-')] : [];
    return [...new Set([raw, cleaned, mapped, ...variants].filter(Boolean))];
}

async function fetchLastEvents(teamId) {
    const r = await http.get('https://www.thesportsdb.com/api/v1/json/3/eventslast.php', { params: { id: teamId } });
    return r.data?.results || [];
}

async function fetchNextEvents(teamId) {
    const r = await http.get('https://www.thesportsdb.com/api/v1/json/3/eventsnext.php', { params: { id: teamId } });
    return r.data?.events || [];
}

function summarizeRecentForm(sideLabel, events, resolvedName) {
    const usable = (events || []).filter(e => e.intHomeScore !== null && e.intAwayScore !== null).slice(0, 5);
    if (!usable.length) return `${sideLabel}(${resolvedName})近况暂无比分数据`;
    let win = 0, draw = 0, loss = 0, gf = 0, ga = 0;
    usable.forEach(e => {
        const isHome = e.strHomeTeam === resolvedName;
        const own = Number(isHome ? e.intHomeScore : e.intAwayScore);
        const opp = Number(isHome ? e.intAwayScore : e.intHomeScore);
        gf += own; ga += opp;
        if (own > opp) win += 1;
        else if (own === opp) draw += 1;
        else loss += 1;
    });
    return `${sideLabel}近${usable.length}场${win}胜${draw}平${loss}负，进${gf}失${ga}(${resolvedName})`;
}

function summarizeSchedule(homeName, homeNext, awayName, awayNext) {
    const homeText = summarizeNextEvents(homeName, homeNext);
    const awayText = summarizeNextEvents(awayName, awayNext);
    return `${homeText}；${awayText}`;
}

function summarizeNextEvents(teamName, events) {
    const next = (events || []).slice(0, 3);
    if (!next.length) return `${teamName}未来赛程暂无公开数据`;
    return `${teamName}未来${next.length}场：${next.map(e => `${e.dateEvent || '未知日期'} vs ${e.strHomeTeam === teamName ? e.strAwayTeam : e.strHomeTeam}`).join('，')}`;
}

function summarizeH2H(homeName, awayName, homeLast, awayLast) {
    const all = [...(homeLast || []), ...(awayLast || [])];
    const seen = new Set();
    const h2h = all.filter(e => {
        const key = e.idEvent;
        if (seen.has(key)) return false;
        seen.add(key);
        return [e.strHomeTeam, e.strAwayTeam].includes(homeName) && [e.strHomeTeam, e.strAwayTeam].includes(awayName);
    }).slice(0, 5);
    if (!h2h.length) return '';
    return `近${h2h.length}次公开交锋：${h2h.map(e => `${e.dateEvent || ''} ${e.strHomeTeam} ${e.intHomeScore ?? '-'}:${e.intAwayScore ?? '-'} ${e.strAwayTeam}`).join('；')}`;
}

function inferMotivationFromSchedule(match, homeNext, awayNext) {
    const lowOddSide = match.s < match.f ? match.homeTeam : match.awayTeam;
    const gap = Math.abs(match.s - match.f);
    const scheduleText = [homeNext?.[0]?.strLeague, awayNext?.[0]?.strLeague].filter(Boolean).join('/');
    const pressure = gap > 0.8 ? `${lowOddSide}为盘口低赔方向，市场预期更强` : '胜负赔率差距不大，盘口未给出绝对战意倾向';
    const multiLine = /Cup|Champions|Europa|ACL|FA/i.test(scheduleText) ? '后续赛程含杯赛/洲际赛事，存在轮换变量' : '后续赛程未识别到明显杯赛分心';
    return `${pressure}；${multiLine}`;
}

async function fetchWeather(city) {
    if (!city) return missingItem('天气', '未识别主队城市，可在“天气场地”里手动填写城市或天气。');
    try {
        const geo = await http.get('https://geocoding-api.open-meteo.com/v1/search', {
            params: { name: city, count: 1, language: 'zh', format: 'json' }
        });
        const place = geo.data?.results?.[0];
        if (!place) return missingItem('天气', `Open-Meteo 未匹配到城市：${city}`);
        const weather = await http.get('https://api.open-meteo.com/v1/forecast', {
            params: {
                latitude: place.latitude,
                longitude: place.longitude,
                current: 'temperature_2m,precipitation,wind_speed_10m',
                timezone: 'auto'
            }
        });
        const c = weather.data?.current;
        if (!c) return missingItem('天气', `Open-Meteo 暂无 ${city} 当前天气。`);
        return {
            name: '天气',
            status: 'verified',
            value: `${place.name} ${c.temperature_2m}°C，降水 ${c.precipitation}mm，风速 ${c.wind_speed_10m}km/h`,
            source: 'Open-Meteo'
        };
    } catch (e) {
        return missingItem('天气', `天气查询失败：${e.message}`);
    }
}

function manualItem(name, value) {
    if (!value) return missingItem(name, '未提供，暂不参与修正。');
    return { name, status: 'manual', value, source: '用户输入' };
}

function addManualIntelligence(items, name, value) {
    if (value) {
        items.push(manualItem(name, value));
        return;
    }
    const alreadyHasVerified = items.some(item => item.name === name && item.status === 'verified');
    const alreadyHasMissing = items.some(item => item.name === name && item.status === 'missing');
    if (!alreadyHasVerified && !alreadyHasMissing) items.push(missingItem(name, '未提供，暂不参与修正。'));
}

function verifiedItem(name, value, source) {
    return { name, status: 'verified', value, source };
}

function missingItem(name, reason) {
    return { name, status: 'missing', value: reason, source: '未验证' };
}

function analyzeMarket(match, intelligence) {
    const inv = [1 / match.s, 1 / match.p, 1 / match.f];
    const margin = inv.reduce((a, b) => a + b, 0);
    const probS = inv[0] / margin;
    const probP = inv[1] / margin;
    const probF = inv[2] / margin;
    const baseHome = Math.max(0.25, 1.1 + (probS - probF) * 1.9);
    const baseAway = Math.max(0.25, 1.0 + (probF - probS) * 1.9);
    const factors = factorAdjustment(intelligence);
    const homeLambda = clamp(baseHome * factors.home, 0.2, 4.2);
    const awayLambda = clamp(baseAway * factors.away, 0.2, 4.2);
    const scoreMatrix = calculateScoreMatrix(homeLambda, awayLambda);
    const best = scoreMatrix[0].score;
    const capitalDesiredScore = calculateScoreMatrix(homeLambda * 1.05, awayLambda * 0.95)[0].score;
    const capitalIntent = describeCapital(match, probS, probP, probF);
    const totalGoals = analyzeTotalGoals(homeLambda, awayLambda, scoreMatrix);

    return {
        probS,
        probP,
        probF,
        homeLambda,
        awayLambda,
        scoreMatrix,
        totalGoals,
        capitalDesiredScore,
        capitalIntent,
        capitalReason: `【赔率结构】主胜:${match.s} / 平:${match.p} / 客胜:${match.f}，返还率估算 ${(100 / margin).toFixed(1)}%。<br>` +
            `【真实情报带入】${factors.logs.join('；') || '暂无可验证修正项'}。<br>` +
            `【盘口结论】最高概率比分 ${best}，资本预期比分 ${capitalDesiredScore}；该结论依赖当前赔率快照，不等同临场终盘。`
    };
}

function analyzeTotalGoals(homeLambda, awayLambda, scoreMatrix) {
    const expected = homeLambda + awayLambda;
    const goalBuckets = new Map();
    scoreMatrix.forEach(row => {
        const [h, a] = row.score.split(':').map(Number);
        const total = h + a;
        goalBuckets.set(total, (goalBuckets.get(total) || 0) + row.prob);
    });
    const recommended = [...goalBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([goals]) => goals);
    const direction = expected >= 3 ? '偏大球' : expected <= 2.15 ? '偏小球' : '中性';
    return {
        expected: Number(expected.toFixed(2)),
        recommended,
        direction,
        label: `${direction}，推荐总进球 ${recommended.join('/')} 球，期望 ${expected.toFixed(2)}`
    };
}

function factorAdjustment(intelligence) {
    let home = 1;
    let away = 1;
    const logs = [];
    for (const item of intelligence.items) {
        const text = String(item.value || '');
        if ((item.name === '天气' && item.status === 'verified') || (item.name === '天气场地' && item.status === 'manual')) {
            if (/降水\s*(?:[2-9]|\d{2,})/.test(text) || /风速\s*(?:2[5-9]|[3-9]\d)/.test(text)) {
                home *= 0.94;
                away *= 0.94;
                logs.push(`天气偏恶劣，总进球下修`);
            } else if (/(雨|雪|大风|湿滑|恶劣|高温|低温)/.test(text)) {
                home *= 0.95;
                away *= 0.95;
                logs.push(`${item.name}: 场地或天气不利，总进球下修`);
            } else {
                logs.push(`天气可查且未触发恶劣修正`);
            }
        }
        if (hasNegativeTeamSignal(text, '主队')) { home *= 0.9; logs.push(`${item.name}: 主队负面`); }
        if (hasNegativeTeamSignal(text, '客队')) { away *= 0.9; logs.push(`${item.name}: 客队负面`); }
        if (/主队.*(连胜|强烈|必须|争冠|保级)/.test(text)) { home *= 1.08; logs.push(`${item.name}: 主队正面`); }
        if (/客队.*(连胜|强烈|必须|争冠|保级)/.test(text)) { away *= 1.08; logs.push(`${item.name}: 客队正面`); }
        const form = parseRecentFormSignal(text);
        if (form.home) {
            home *= form.home.factor;
            logs.push(`${item.name}: ${form.home.log}`);
        }
        if (form.away) {
            away *= form.away.factor;
            logs.push(`${item.name}: ${form.away.log}`);
        }
        if (/后续赛程含杯赛|轮换变量|一周双赛|体能/.test(text)) {
            home *= 0.97;
            away *= 0.97;
            logs.push(`${item.name}: 存在赛程/轮换变量，总体进攻效率小幅下修`);
        }
    }
    return { home, away, logs };
}

function parseRecentFormSignal(text) {
    const result = {};
    const re = /(主队|客队)近(\d+)场(\d+)胜(\d+)平(\d+)负，进(\d+)失(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const side = m[1] === '主队' ? 'home' : 'away';
        const games = Number(m[2]);
        const wins = Number(m[3]);
        const losses = Number(m[5]);
        const gf = Number(m[6]);
        const ga = Number(m[7]);
        let factor = 1;
        const logs = [];
        if (games >= 3 && wins / games >= 0.6) { factor *= 1.07; logs.push(`${m[1]}近况强势`); }
        if (games >= 3 && losses / games >= 0.6) { factor *= 0.92; logs.push(`${m[1]}近况低迷`); }
        if (games && gf / games >= 2) { factor *= 1.05; logs.push(`${m[1]}火力偏强`); }
        if (games && ga / games >= 2) { factor *= 0.97; logs.push(`${m[1]}防守失球偏多`); }
        if (logs.length) result[side] = { factor, log: logs.join('、') };
    }
    return result;
}

function hasNegativeTeamSignal(text, teamLabel) {
    const teamText = String(text);
    if (new RegExp(`${teamLabel}.{0,6}(无|没有|暂无|未见).{0,8}(伤|停|缺)`).test(teamText)) return false;
    return new RegExp(`${teamLabel}.*(伤停严重|核心伤停|多人伤停|伤|停|缺|轮换|低迷|防线崩)`).test(teamText);
}

function describeCapital(match, ps, pp, pf) {
    const favorite = ps > pf ? `${match.homeTeam}方向` : `${match.awayTeam}方向`;
    if (Math.max(ps, pf) > 0.62) return `低赔强势盘：市场明显集中在${favorite}，需重点观察临场是否降赔或升水`;
    if (Math.abs(ps - pf) < 0.06) return `均势盘：胜负两端接近，平局与让球盘分流价值更高`;
    if (pp > 0.3) return `平局保护盘：平赔隐含概率偏高，资本更像在防范胶着走势`;
    return `常规分歧盘：主客胜概率有差距，但未形成绝对深盘`;
}

function calculateScoreMatrix(homeLambda, awayLambda) {
    const rows = [];
    for (let h = 0; h <= 7; h++) {
        for (let a = 0; a <= 7; a++) {
            rows.push({ score: `${h}:${a}`, prob: poisson(h, homeLambda) * poisson(a, awayLambda) });
        }
    }
    return rows.sort((x, y) => y.prob - x.prob).slice(0, 8);
}

function poisson(k, lambda) {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function factorial(n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}

function consensusScore(modelScores, scoreMatrix) {
    if (!modelScores.length) return scoreMatrix[0].score;
    const counts = new Map();
    modelScores.forEach(score => counts.set(score, (counts.get(score) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function reviewPastedAiText(aiText, market) {
    const text = String(aiText || '').trim();
    const scoreMatches = [...text.matchAll(/\b([0-7])\s*[:：]\s*([0-7])\b/g)]
        .map(m => `${Number(m[1])}:${Number(m[2])}`);
    const uniqueScores = [...new Set(scoreMatches)].slice(0, 6);
    const topMarketScores = market.scoreMatrix.slice(0, 5).map(x => x.score);
    const scoreHits = uniqueScores.filter(score => topMarketScores.includes(score));
    const aiLean = inferLeanFromText(text);
    const marketLean = inferMarketLean(market);
    const riskWords = extractRiskWords(text);
    const aiGoals = extractGoalRecommendations(text);
    const localGoals = market.totalGoals?.recommended || [];
    const goalHits = aiGoals.filter(goal => localGoals.includes(goal));
    const conflictLogs = [];

    if (aiLean !== '不明' && marketLean !== '不明' && aiLean !== marketLean) {
        conflictLogs.push(`AI 倾向「${aiLean}」与盘口隐含倾向「${marketLean}」不一致`);
    }
    if (uniqueScores.length && !scoreHits.length) {
        conflictLogs.push(`AI 比分 ${uniqueScores.join('、')} 未落在盘口模型前五候选 ${topMarketScores.join('、')} 内`);
    }
    if (/大胜|穿盘|稳胆|必胜|稳赢|绝对/.test(text)) {
        conflictLogs.push('AI 文本出现强确定性词汇，建议降低主观权重');
    }
    if (aiGoals.length && !goalHits.length) {
        conflictLogs.push(`AI 推荐球数 ${aiGoals.join('/')} 与本地推荐 ${localGoals.join('/')} 不一致`);
    }

    const agreementScore = clamp(
        52 + scoreHits.length * 12 + goalHits.length * 6 + (aiLean === marketLean ? 14 : 0) - conflictLogs.length * 10 - riskWords.length * 3,
        18,
        92
    );
    const finalScore = scoreHits[0] || market.scoreMatrix[0].score;
    const action = agreementScore >= 72
        ? 'AI 结论与盘口模型较一致，可作为主判断参考。'
        : agreementScore >= 55
            ? 'AI 与盘口部分一致，建议按盘口模型候选比分做保守取舍。'
            : 'AI 与盘口冲突较多，建议优先回到赔率/让球/情报数据，不宜直接采信。';

    return {
        extractedScores: uniqueScores,
        topMarketScores,
        scoreHits,
        aiGoals,
        localGoals,
        goalHits,
        aiLean,
        marketLean,
        riskWords,
        conflictLogs,
        agreementScore: `${agreementScore.toFixed(1)}%`,
        finalScore,
        summary: action
    };
}

function extractGoalRecommendations(text) {
    const goals = new Set();
    const direct = [...text.matchAll(/(?:推荐总进球|推荐球数|总进球|进球数|球数)[^\d]{0,8}(\d)(?:\s*[\/、,，或]\s*(\d))?(?:\s*[\/、,，或]\s*(\d))?/g)];
    direct.forEach(m => [m[1], m[2], m[3]].filter(Boolean).forEach(n => goals.add(Number(n))));
    const range = [...text.matchAll(/([0-7])\s*[-~到至]\s*([0-7])\s*球/g)];
    range.forEach(m => {
        const start = Number(m[1]);
        const end = Number(m[2]);
        for (let n = Math.min(start, end); n <= Math.max(start, end); n++) goals.add(n);
    });
    return [...goals].filter(n => Number.isFinite(n)).slice(0, 5);
}

function inferLeanFromText(text) {
    if (/(主胜|主队胜|看好主队|主队不败|主队方向|主队打出)/.test(text)) return '主队';
    if (/(客胜|客队胜|看好客队|客队不败|客队方向|客队打出)/.test(text)) return '客队';
    if (/(平局|握手言和|防平|平赔|平局保护)/.test(text)) return '平局';
    return '不明';
}

function inferMarketLean(market) {
    const max = Math.max(market.probS, market.probP, market.probF);
    if (max === market.probS) return '主队';
    if (max === market.probF) return '客队';
    if (max === market.probP) return '平局';
    return '不明';
}

function extractRiskWords(text) {
    const words = ['伤停', '轮换', '天气', '雨', '大风', '体能', '杯赛', '保级', '争冠', '盘口诱导', '降盘', '升盘', '临场', '冷门'];
    return words.filter(w => text.includes(w));
}

async function runSelectedModels(payload, flags) {
    const selected = [
        ['deepseek', flags.useDeepSeek],
        ['chatgpt', flags.useChatGPT],
        ['marketBase', flags.useMarketBase]
    ];
    return Promise.all(selected.map(([name, enabled]) => enabled ? callModel(name, payload) : Promise.resolve({ name, status: 'disabled' })));
}

async function callModel(name, payload) {
    const config = getRuntimeModelConfig(name, payload.apiKeys || {});
    if (name === 'marketBase') {
        const top = payload.market.scoreMatrix.slice(0, 3);
        return {
            name,
            status: 'verified',
            score: top[0].score,
            text: `赔率泊松基准：前三候选 ${top.map(x => `${x.score}(${(x.prob * 100).toFixed(1)}%)`).join('、')}。这是本地数学模型，不调用外部大模型。`
        };
    }
    if (!config?.enabled) {
        const need = 'API Key';
        return { name, status: 'missing_key', message: `${config.label} 未配置 ${need}，未进行真实模型调用。` };
    }
    const prompt = buildModelPrompt(payload);
    try {
        let text = '';
        const r = await http.post(config.url, {
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2
        }, { headers: { Authorization: `Bearer ${config.key}` } });
        text = r.data?.choices?.[0]?.message?.content || '';
        const score = (text.match(/\b[0-7]\s*[:：]\s*[0-7]\b/) || [])[0]?.replace('：', ':').replace(/\s+/g, '');
        return { name, status: 'verified', score, text: text.slice(0, 500) };
    } catch (e) {
        return { name, status: 'error', message: `${config.label} 调用失败：${formatProviderError(e)}` };
    }
}

function formatProviderError(e) {
    const status = e.response?.status;
    const data = e.response?.data;
    const providerMessage = data?.error?.message || data?.message || data?.error || '';
    const providerCode = data?.error?.code || data?.code || '';
    const detail = [status ? `HTTP ${status}` : '', providerCode, providerMessage].filter(Boolean).join(' / ');
    return detail || e.message;
}

function getRuntimeModelConfig(name, apiKeys) {
    const config = { ...MODEL_CONFIG[name] };
    if (name === 'deepseek' && apiKeys.deepseek) {
        config.enabled = true;
        config.key = sanitizeApiKey(apiKeys.deepseek);
    }
    if (name === 'chatgpt' && apiKeys.chatgpt) {
        config.enabled = true;
        config.key = sanitizeApiKey(apiKeys.chatgpt);
    }
    return config;
}

function sanitizeApiKey(key) {
    return String(key || '').trim().replace(/\\_/g, '_');
}

function buildModelPrompt({ match, intelligence, market }) {
    return [
        '你是足球赛前数据分析助手。只基于以下已给数据推断，不要编造伤停、阵型、天气、历史交锋。',
        `比赛：${match.homeTeam} vs ${match.awayTeam}，时间：${match.matchTime}`,
        `赔率：${match.s}/${match.p}/${match.f}，让球：${match.rangNum}`,
        `进球期望：主 ${market.homeLambda.toFixed(2)}，客 ${market.awayLambda.toFixed(2)}`,
        `情报：${intelligence.items.map(i => `${i.name}[${i.status}]:${i.value}`).join(' | ')}`,
        '请输出一个最可能比分，格式必须包含“比分 x:y”，并用两句话说明理由。'
    ].join('\n');
}

function formatModelBlock(models, name) {
    const m = models.find(x => x.name === name);
    const label = MODEL_CONFIG[name].label;
    if (!m || m.status === 'disabled') return disabledBlock(label, '未启用');
    if (m.status === 'missing_key' || m.status === 'error') return `⚠️ <strong>${label}：</strong>${m.message}`;
    return `✅ <strong>${label} 真实调用：</strong>比分 <span class="font-bold">${m.score || '未提取'}</span> | ${escapeHtml(m.text || '').replace(/\n/g, '<br>')}`;
}

function disabledBlock(label, reason) {
    return `⚪ <strong>${label}：</strong>${reason}`;
}

function buildAiReason(intelligence, market, models, score) {
    const verified = intelligence.verified.map(i => `${i.name}:${i.value}`).join('；') || '暂无自动验证数据';
    const manual = intelligence.manual.map(i => `${i.name}:${i.value}`).join('；') || '暂无人工补充';
    const modelStatus = models.map(m => `${MODEL_CONFIG[m.name].label}:${m.status}`).join(' / ');
    return `【数据源】自动验证：${verified}<br>` +
        `【人工条件】${manual}<br>` +
        `【赔率模型】主λ:${market.homeLambda.toFixed(2)} 客λ:${market.awayLambda.toFixed(2)}，前三候选 ${market.scoreMatrix.slice(0, 3).map(x => `${x.score}(${(x.prob * 100).toFixed(1)}%)`).join('、')}。<br>` +
        `【模型状态】${modelStatus}<br>` +
        `【聚合结论】${score}。`;
}

function calculateMeihuaYishu(match) {
    const digits = String(match.code + match.matchTime).replace(/\D/g, '');
    const seed = Number.parseInt(digits.slice(-6), 10) || Math.floor(Date.now() / 60000);
    const upper = seed % 8 || 8;
    const lower = Math.floor(seed / 8) % 8 || 8;
    const moving = seed % 6 || 6;
    const names = { 1: '乾', 2: '兑', 3: '离', 4: '震', 5: '巽', 6: '坎', 7: '艮', 8: '坤' };
    const lean = moving <= 2 ? '主队先手更足' : moving <= 4 ? '中盘拉扯偏强' : '客队后程变量更大';
    return `☯️ <strong>梅花易数：</strong>按编号与开赛时间起卦，上卦【${names[upper]}】下卦【${names[lower]}】，动爻${moving}；象意参考：${lean}。此项为传统术数参考，不标记为真实赛事数据。`;
}

function calculateCompleteness(intelligence, models) {
    const verified = intelligence.verified.length;
    const manual = intelligence.manual.length;
    const realModels = models.filter(m => m.status === 'verified').length;
    const score = Math.min(92, 38 + verified * 10 + manual * 5 + realModels * 8);
    return {
        confidence: score.toFixed(1),
        verifiedCount: verified,
        manualCount: manual,
        missingCount: intelligence.missing.length,
        realModelCalls: realModels,
        note: '置信度为数据完整度评分，不是命中概率。'
    };
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
