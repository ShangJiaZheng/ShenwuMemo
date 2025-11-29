const fs = require('fs');
const promises = require('fs/promises');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const express = require('express');
const app = express();
app.use(express.static('public'));
app.use('/image', express.static('image')); // 添加image文件夹的静态文件服务
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 添加cy227.com预览路由
app.get('/preview-cy227', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>cy227.com预览</title>
            <style>
                body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; }
                iframe { width: 100%; height: 100%; border: 0; }
            </style>
        </head>
        <body>
            <iframe src="https://cy227.com/goodsList/3" allowfullscreen></iframe>
        </body>
        </html>
    `);
});

const multer = require('multer'); // 新增文件上传中间件
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/')
    },
    filename: function (req, file, cb) {
        const date = req.body.date || new Date().toISOString().split('T')[0];
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `${date}_${timestamp}${ext}`)
    }
});
const upload = multer({ storage: storage });
const targetDir = path.join(__dirname, 'public'); // 确保是绝对路径（与 index.html 同级）
const port = 3000;

// 新增：删除图片文件接口
app.delete('/deletefile', async (req, res) => {
    const filename = req.query.filename;
    if (!filename) {
        return res.status(400).json({ error: '缺少必要参数 filename' });
    }

    // 安全校验：防止路径遍历攻击（仅允许合法文件名）
    if (!/^[\w\-.]+\.(png|jpe?g|gif|webp)$/i.test(filename)) {
        return res.status(400).json({ error: '无效的文件名'});
    }

    const filePath = path.join(targetDir, filename); // 拼接完整路径（public目录下）
    
    try {
        // 检查文件是否存在
        await promises.access(filePath, fs.constants.F_OK);
        // 删除文件
        await promises.unlink(filePath);
        res.json({ success: true, message: '文件删除成功' });
    } catch (err) {
        console.error('删除文件失败:', err);
        res.status(500).json({ error: '文件删除失败' });
    }
});

// 获取指定日期的图片列表（兼容前端接口）
app.get('/get_images', async (req, res) => {
    try {
        // 1. 解析并验证日期参数（格式：YYYYMMDD）
        const dateParam = req.query.date.replaceAll('-', '');
        if (!dateParam) {
            return res.status(400).json({ error: '缺少日期参数 date（格式：YYYYMMDD）' });
        }
        if (!/^\d{8}$/.test(dateParam)) { // 验证是否为 8 位数字
            return res.status(400).json({ error: '日期格式错误，需为 YYYYMMDD（如 20250506）' });
        }
        // 2. 读取目录并筛选文件
        const files = await promises.readdir(targetDir);
        const todayFiles = files.filter(file => 
            file.startsWith(dateParam) && // 严格匹配参数中的日期前缀
            /\.(png|jpe?g|gif|webp)$/i.test(file) // 可选：仅保留图片文件
        );

        res.json(todayFiles); // 直接返回文件数组，兼容前端
    } catch (err) {
        console.error('获取文件失败:', err);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 获取指定日期的剩余银币和消耗银币数据
app.get('/get_daily_data', (req, res) => {
    const dateParam = req.query.date;
    if (!dateParam) {
        return res.status(400).json({ error: '请提供日期参数' });
    }

    const dataFilePath = path.join(__dirname, 'data', 'data.csv');
    
    if (!fs.existsSync(dataFilePath)) {
        return res.json({ 剩余银币: 0, 消耗银币: 0, exists: false });
    }

    const results = [];
    fs.createReadStream(dataFilePath)
      .pipe(csv())
      .on('data', (data) => {
            if (data.日期 === dateParam) {
                results.push({
                    剩余银币: parseInt(data.剩余银币) || 0,
                    消耗银币: parseInt(data.消耗银币) || 0,
                    exists: true
                });
            }
        })
      .on('end', () => {
            if (results.length > 0) {
                res.json(results[0]);
            } else {
                res.json({ 剩余银币: 0, 消耗银币: 0, exists: false });
            }
        })
      .on('error', (error) => {
            console.error('读取CSV文件失败:', error);
            res.json({ 剩余银币: 0, 消耗银币: 0, exists: false });
        });
});

// 上传
app.post('/upload', upload.single('image'), (req, res) => {
    const date = req.body.date.replaceAll('-', '');
    const fileName = `${date}_${Date.now()}.png`;
    const targetPath = path.join(__dirname, 'public', fileName);
    
    // 重命名文件（从临时目录移动到目标路径）
    fs.rename(req.file.path, targetPath, (err) => {
        if (err) {
            console.error('文件重命名失败:', err);
            return res.status(500).json({ success: false, message: '上传失败' });
        }
        res.json({ success: true, filename: fileName });
    });
});

// 读取 CSV 文件，支持分页和排序
app.get('/data', (req, res) => {
    const results = [];
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 1000; // 移除10条限制
    const sortBy = req.query.sortBy || '日期';
    const sortOrder = req.query.sortOrder || 'desc';

    // 检查数据文件是否存在
    const dataFilePath = path.join(__dirname, 'data', 'data.csv');
    if (!fs.existsSync(dataFilePath)) {
        // 如果文件不存在，返回空数据
        return res.json({
            records: [],
            totalSilver: 0,
            totalExpense: 0,
            averageDailyIncome: 0,
            recordDays: 0
        });
    }

    fs.createReadStream(dataFilePath)
      .pipe(csv())
      .on('data', (data) => {
            results.push(data);
        })
      .on('end', () => {
            let last7Day = [];
            let last30Day = [];
            let totalSilver = 0;
            let totalExpense = 0;
            let averageDailyIncome = 0;
            let recordDays = results.length;

            // 计算今日收益和统计数据
            results.forEach((row, index) => {
                // 转换为数字
                row['剩余银币'] = parseInt(row['剩余银币']) || 0;
                row['消耗银币'] = parseInt(row['消耗银币']) || 0;
                
                if (index > 0) {
                    const prevRow = results[index - 1];
                    row['今日收益'] = row['剩余银币'] - prevRow['剩余银币'] + row['消耗银币'];
                    last7Day.push(row['今日收益']);
                    if (last7Day.length > 7) {
                        last7Day.shift();
                    }
                    last30Day.push(row['今日收益']);
                    if (last30Day.length > 30) {
                        last30Day.shift();
                    }
                    
                    // 计算平均值
                    let sum7Day = 0;
                    for (let i = 0; i < last7Day.length; i++) {
                        sum7Day += parseFloat(last7Day[i]);
                    }
                    let sum30Day = 0;
                    for (let i = 0; i < last30Day.length; i++) {
                        sum30Day += parseFloat(last30Day[i]);
                    }
                    
                    row['周平均收益'] = last7Day.length > 0 ? (sum7Day / last7Day.length).toFixed(2) : 0;
                    row['月平均收益'] = last30Day.length > 0 ? (sum30Day / last30Day.length).toFixed(2) : 0;
                } else {
                    // 对于第一行数据，今日收益就是当前剩余银币（假设是初始投资）
                    row['今日收益'] = row['剩余银币'];
                    row['周平均收益'] = 0;
                    row['月平均收益'] = 0;
                }
                
                // 累加统计数据
                totalSilver = row['剩余银币'];
                totalExpense += row['消耗银币'];
            });

            // 计算日均收益
            let totalIncome = 0;
            let incomeDays = 0;
            results.forEach((row) => {
                if (row['今日收益'] && !isNaN(parseFloat(row['今日收益']))) {
                    totalIncome += parseFloat(row['今日收益']);
                    incomeDays++;
                }
            });
            averageDailyIncome = incomeDays > 0 ? (totalIncome / incomeDays).toFixed(2) : 0;

            // 过滤掉20250831及以前的数据
            const filterDate = new Date('2025-08-31');
            const filteredResults = results.filter(row => {
                return new Date(row.日期) > filterDate;
            });
            
            // 更新记录天数为过滤后的结果长度
            recordDays = filteredResults.length;

            // 排序 - 将字符串转换为数字进行比较
            filteredResults.sort((a, b) => {
                let valA = a[sortBy];
                let valB = b[sortBy];
                
                // 如果是数字类型的字段，转换为数字比较
                if (sortBy === '剩余银币' || sortBy === '消耗银币' || sortBy === '今日收益' || sortBy === '周平均收益' || sortBy === '月平均收益') {
                    valA = parseFloat(String(valA).replace(/,/g, '')) || 0;
                    valB = parseFloat(String(valB).replace(/,/g, '')) || 0;
                }
                
                if (sortOrder === 'asc') {
                    return valA > valB ? 1 : -1;
                } else {
                    return valA < valB ? 1 : -1;
                }   
            });

            // 分页
            const startIndex = (page - 1) * limit;
            const endIndex = startIndex + limit;
            const paginatedResults = filteredResults.slice(startIndex, endIndex);

            // 返回统一格式的数据
            res.json({
                data: paginatedResults,
                records: paginatedResults,
                totalSilver: totalSilver,
                totalExpense: totalExpense,
                averageDailyIncome: averageDailyIncome,
                recordDays: recordDays
            });
        })
        .on('error', (error) => {
            console.error('读取CSV文件失败:', error);
            // 如果读取失败，返回空数据
            res.json({
                data: [],
                records: [],
                totalSilver: 0,
                totalExpense: 0,
                averageDailyIncome: 0,
                recordDays: 0
            });
        });
});

// 追加或覆盖数据到 CSV 文件
app.post('/add', (req, res) => {
    const newRow = {
        日期: req.body.日期,
        剩余银币: req.body.剩余银币,
        消耗银币: req.body.消耗银币,
        备注: req.body.备注,
    };

    const allData = [];
    fs.createReadStream(path.join(__dirname, 'data', 'data.csv'))
      .pipe(csv())
      .on('data', (data) => allData.push(data))
      .on('end', () => {
            let dateExists = false;
            for (let i = 0; i < allData.length; i++) {
                if (allData[i].日期 === newRow.日期) {
                    allData[i] = newRow;
                    dateExists = true;
                    break;
                }
            }
            if (!dateExists) {
                allData.push(newRow);
            }
            if (newRow.剩余银币 === '' || isNaN(newRow.剩余银币)) {
            	  newRow.剩余银币 = '0';
            }
            if (newRow.消耗银币 === '' || isNaN(newRow.消耗银币)) {
            	  newRow.消耗银币 = '0';
            }

            const csvWriter = createCsvWriter({
                path: path.join(__dirname, 'data', 'data.csv'),
                header: [
                    { id: '日期', title: '日期' },
                    { id: '剩余银币', title: '剩余银币' },
                    { id: '消耗银币', title: '消耗银币' },
                ]
            });

            csvWriter.writeRecords(allData)
              .then(() => {
                    res.sendStatus(200);
                })
              .catch((error) => {
                    console.error(error);
                    res.sendStatus(500);
                });
        });
});



// 获取指定日期的消耗银币
app.get('/get_expense', async (req, res) => {
    try {
        const { date } = req.query;
        
        const filePath = path.join(__dirname, 'data', 'data.csv');
        
        // 检查文件是否存在
        try {
            await promises.access(filePath);
        } catch (accessError) {
            return res.json({ success: true, expense: 0 });
        }
        
        let expense = 0;
        let found = false;
        
        const stream = fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                if (row.日期 === date && row.消耗银币) {
                    expense = parseFloat(row.消耗银币) || 0;
                    found = true;
                }
            })
            .on('end', () => {
                res.json({ success: true, expense: Math.round(expense) });
            })
            .on('error', (error) => {
                console.error('读取CSV文件错误:', error);
                res.json({ success: true, expense: 0 });
            });
    } catch (error) {
        console.error('获取消耗银币失败:', error);
        res.json({ success: true, expense: 0 });
    }
});

// 获取指定日期的剩余银币
app.get('/get_remaining', async (req, res) => {
    try {
        const { date } = req.query;
        
        const filePath = path.join(__dirname, 'data', 'data.csv');
        
        // 检查文件是否存在
        try {
            await promises.access(filePath);
        } catch (accessError) {
            return res.json({ success: true, remaining: 0 });
        }
        
        let remaining = 0;
        
        const stream = fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                if (row.日期 === date && row.剩余银币) {
                    remaining = parseFloat(row.剩余银币) || 0;
                }
            })
            .on('end', () => {
                res.json({ success: true, remaining: Math.round(remaining) });
            })
            .on('error', (error) => {
                console.error('读取CSV文件错误:', error);
                res.json({ success: true, remaining: 0 });
            });
    } catch (error) {
        console.error('获取剩余银币失败:', error);
        res.json({ success: true, remaining: 0 });
    }
});

// 获取指定日期的图片列表
app.get('/get_images', async (req, res) => {
    try {
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({ success: false, message: '日期参数不能为空' });
        }
        
        const imagesDir = path.join(__dirname, 'public');
        
        // 读取public目录下的所有文件
        const files = await promises.readdir(imagesDir);
        
        // 筛选出以指定日期开头的图片文件
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif') && 
                   file.startsWith(date);
        });
        
        res.json(imageFiles);
    } catch (error) {
        console.error('获取图片列表失败:', error);
        res.json([]); // 返回空数组而不是错误，避免前端崩溃
    }
});

// 获取备注数据
app.get('/get_notes', async (req, res) => {
    try {
        const notesFilePath = path.join(__dirname, 'data', 'notes.csv');
        
        // 检查文件是否存在
        try {
            await promises.access(notesFilePath);
        } catch (accessError) {
            // 文件不存在，返回空的备注数据
            const emptyNotes = {
                note1: '',
                note2: '',
                note3: '',
                note4: '',
                note5: '',
                note6: '',
                note7: ''
            };
            return res.json(emptyNotes);
        }
        
        const notes = {};
        let found = false;
        
        // 读取CSV文件
        const stream = fs.createReadStream(notesFilePath)
            .pipe(csv())
            .on('data', (row) => {
                // 假设CSV只有一行数据，包含所有备注
                for (let i = 1; i <= 7; i++) {
                    const noteKey = `note${i}`;
                    if (row[noteKey] !== undefined) {
                        notes[noteKey] = row[noteKey];
                    }
                }
                found = true;
            })
            .on('end', () => {
                if (!found) {
                    // 文件存在但没有数据
                    const emptyNotes = {
                        note1: '',
                        note2: '',
                        note3: '',
                        note4: '',
                        note5: '',
                        note6: '',
                        note7: ''
                    };
                    res.json(emptyNotes);
                } else {
                    res.json(notes);
                }
            })
            .on('error', (error) => {
                console.error('读取备注文件错误:', error);
                res.status(500).json({ error: '读取备注文件失败' });
            });
    } catch (error) {
        console.error('获取备注失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 保存备注数据
app.post('/save_notes', async (req, res) => {
    try {
        // 确保data目录存在
        const dataDir = path.join(__dirname, 'data');
        try {
            await promises.mkdir(dataDir, { recursive: true });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') {
                console.error('创建data目录失败:', mkdirError);
                return res.status(500).json({ success: false, message: '创建数据目录失败' });
            }
        }
        
        const notesFilePath = path.join(__dirname, 'data', 'notes.csv');
        
        // 准备要保存的数据
        const notesData = [{
            note1: req.body.note1 || '',
            note2: req.body.note2 || '',
            note3: req.body.note3 || '',
            note4: req.body.note4 || '',
            note5: req.body.note5 || '',
            note6: req.body.note6 || '',
            note7: req.body.note7 || ''
        }];
        
        // 创建CSV写入器
        const csvWriter = createCsvWriter({
            path: notesFilePath,
            header: [
                { id: 'note1', title: 'note1' },
                { id: 'note2', title: 'note2' },
                { id: 'note3', title: 'note3' },
                { id: 'note4', title: 'note4' },
                { id: 'note5', title: 'note5' },
                { id: 'note6', title: 'note6' },
                { id: 'note7', title: 'note7' }
            ]
        });
        
        // 写入数据
        await csvWriter.writeRecords(notesData);
        res.json({ success: true, message: '备注保存成功' });
    } catch (error) {
        console.error('保存备注失败:', error);
        res.status(500).json({ success: false, message: '保存备注失败' });
    }
});

// 保存消耗银币详情
app.post('/save_expense_details', async (req, res) => {
    try {
        // 确保data目录存在
        const dataDir = path.join(__dirname, 'data');
        try {
            await promises.mkdir(dataDir, { recursive: true });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') {
                console.error('创建data目录失败:', mkdirError);
                return res.status(500).json({ success: false, message: '创建数据目录失败' });
            }
        }
        
        const expenseDetailsFilePath = path.join(__dirname, 'data', 'expense_details.csv');
        
        const { date, details } = req.body;
        
        // 检查文件是否存在
        let allDetails = [];
        let fileExists = false;
        
        try {
            await promises.access(expenseDetailsFilePath);
            fileExists = true;
            
            // 读取现有数据
            const existingData = [];
            await new Promise((resolve, reject) => {
                fs.createReadStream(expenseDetailsFilePath)
                    .pipe(csv())
                    .on('data', (row) => existingData.push(row))
                    .on('end', resolve)
                    .on('error', reject);
            });
            
            allDetails = existingData;
        } catch (accessError) {
            // 文件不存在，从空数组开始
        }
        
        // 检查是否已存在该日期的详情
        let foundIndex = -1;
        for (let i = 0; i < allDetails.length; i++) {
            if (allDetails[i].date === date) {
                foundIndex = i;
                break;
            }
        }
        
        if (foundIndex !== -1) {
            // 更新现有记录
            allDetails[foundIndex].details = details;
        } else {
            // 添加新记录
            allDetails.push({ date, details });
        }
        
        // 创建CSV写入器
        const csvWriter = createCsvWriter({
            path: expenseDetailsFilePath,
            header: [
                { id: 'date', title: 'date' },
                { id: 'details', title: 'details' }
            ]
        });
        
        // 写入数据
        await csvWriter.writeRecords(allDetails);
        res.json({ success: true, message: '消耗银币详情保存成功' });
    } catch (error) {
        console.error('保存消耗银币详情失败:', error);
        res.status(500).json({ success: false, message: '保存消耗银币详情失败' });
    }
});

// 获取消耗银币详情
app.get('/get_expense_details', async (req, res) => {
    try {
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({ success: false, message: '日期参数不能为空' });
        }
        
        const expenseDetailsFilePath = path.join(__dirname, 'data', 'expense_details.csv');
        
        // 检查文件是否存在
        try {
            await promises.access(expenseDetailsFilePath);
        } catch (accessError) {
            // 文件不存在，返回空详情
            return res.json({ success: true, details: '' });
        }
        
        let details = '';
        let found = false;
        
        // 读取CSV文件
        await new Promise((resolve, reject) => {
            fs.createReadStream(expenseDetailsFilePath)
                .pipe(csv())
                .on('data', (row) => {
                    if (row.date === date) {
                        details = row.details || '';
                        found = true;
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });
        
        res.json({ success: true, details });
    } catch (error) {
        console.error('获取消耗银币详情失败:', error);
        res.status(500).json({ success: false, message: '获取消耗银币详情失败' });
    }
});

// 保存checkbox状态
app.post('/save_checkboxes', async (req, res) => {
    try {
        // 确保data目录存在
        const dataDir = path.join(__dirname, 'data');
        try {
            await promises.mkdir(dataDir, { recursive: true });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') {
                console.error('创建data目录失败:', mkdirError);
                return res.status(500).json({ success: false, message: '创建数据目录失败' });
            }
        }
        
        const checkboxesFilePath = path.join(__dirname, 'data', 'checkboxes.csv');
        
        const { date, 修炼瓶, 保卫门派 } = req.body;
        
        if (!date) {
            return res.status(400).json({ success: false, message: '日期参数不能为空' });
        }
        
        // 检查文件是否存在
        let allCheckboxes = [];
        let fileExists = false;
        
        try {
            await promises.access(checkboxesFilePath);
            fileExists = true;
            
            // 读取现有数据
            const existingData = [];
            await new Promise((resolve, reject) => {
                fs.createReadStream(checkboxesFilePath)
                    .pipe(csv())
                    .on('data', (row) => existingData.push(row))
                    .on('end', resolve)
                    .on('error', reject);
            });
            
            allCheckboxes = existingData;
        } catch (accessError) {
            // 文件不存在，从空数组开始
        }
        
        // 检查是否已存在该日期的记录
        let foundIndex = -1;
        for (let i = 0; i < allCheckboxes.length; i++) {
            if (allCheckboxes[i].date === date) {
                foundIndex = i;
                break;
            }
        }
        
        if (foundIndex !== -1) {
            // 更新现有记录
            allCheckboxes[foundIndex].修炼瓶 = 修炼瓶;
            allCheckboxes[foundIndex].保卫门派 = 保卫门派;
        } else {
            // 添加新记录
            allCheckboxes.push({ 
                date, 
                修炼瓶, 
                保卫门派
            });
        }
        
        // 创建CSV写入器
        const csvWriter = createCsvWriter({
            path: checkboxesFilePath,
            header: [
                { id: 'date', title: 'date' },
                { id: '修炼瓶', title: '修炼瓶' },
                { id: '保卫门派', title: '保卫门派' }
            ]
        });
        
        // 写入数据
        await csvWriter.writeRecords(allCheckboxes);
        res.json({ success: true, message: 'checkbox状态保存成功' });
    } catch (error) {
        console.error('保存checkbox状态失败:', error);
        res.status(500).json({ success: false, message: '保存checkbox状态失败' });
    }
});

// 获取checkbox状态
app.get('/get_checkboxes', async (req, res) => {
    try {
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({ success: false, message: '日期参数不能为空' });
        }
        
        const checkboxesFilePath = path.join(__dirname, 'data', 'checkboxes.csv');
        
        // 检查文件是否存在
        try {
            await promises.access(checkboxesFilePath);
        } catch (accessError) {
            // 文件不存在，返回空数据
            return res.json({ success: true, exists: false });
        }
        
        let found = false;
        let checkboxData = {};
        
        // 读取CSV文件
        await new Promise((resolve, reject) => {
            fs.createReadStream(checkboxesFilePath)
                .pipe(csv())
                .on('data', (row) => {
                    if (row.date === date) {
                        checkboxData = {
                            修炼瓶: row.修炼瓶,
                            保卫门派: row.保卫门派
                        };
                        found = true;
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });
        
        if (found) {
            res.json({ success: true, exists: true, ...checkboxData });
        } else {
            res.json({ success: true, exists: false });
        }
    } catch (error) {
        console.error('获取checkbox状态失败:', error);
        res.status(500).json({ success: false, message: '获取checkbox状态失败' });
    }
});

// 保存保卫门派输入内容
app.post('/save_guard_input', async (req, res) => {
    try {
        const dataDir = path.join(__dirname, 'data');
        try {
            await promises.mkdir(dataDir, { recursive: true });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') {
                return res.status(500).json({ success: false, message: '创建数据目录失败' });
            }
        }

        const guardFilePath = path.join(__dirname, 'data', 'guard_inputs.csv');
        const { date, content } = req.body;

        if (!date || !content || !String(content).trim()) {
            return res.status(400).json({ success: false, message: '日期和内容不能为空' });
        }

        let all = [];
        try {
            await promises.access(guardFilePath);
            await new Promise((resolve, reject) => {
                fs.createReadStream(guardFilePath)
                    .pipe(csv())
                    .on('data', (row) => { all.push(row); })
                    .on('end', resolve)
                    .on('error', reject);
            });
        } catch (e) {}

        all.push({ date, content: String(content).trim() });

        const csvWriter = createCsvWriter({
            path: guardFilePath,
            header: [
                { id: 'date', title: 'date' },
                { id: 'content', title: 'content' }
            ]
        });
        await csvWriter.writeRecords(all);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: '保存失败' });
    }
});

// 获取指定周的保卫门派输入内容聚合
app.get('/weekly_guard_inputs', async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ success: false, message: '缺少日期范围' });
        }
        const guardFilePath = path.join(__dirname, 'data', 'guard_inputs.csv');
        try {
            await promises.access(guardFilePath);
        } catch (e) {
            return res.json({ success: true, items: [] });
        }

        const startDate = new Date(start);
        const endDate = new Date(end);
        const stats = {};

        await new Promise((resolve, reject) => {
            fs.createReadStream(guardFilePath)
                .pipe(csv())
                .on('data', (row) => {
                    const d = new Date(row.date);
                    if (!isNaN(d) && d >= startDate && d <= endDate) {
                        const key = (row.content || '').trim();
                        if (!key) return;
                        if (!stats[key]) {
                            stats[key] = { count: 0, dates: [] };
                        }
                        stats[key].count += 1;
                        stats[key].dates.push(row.date);
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });

        // 去重日期并排序
        const items = Object.keys(stats).map(k => {
            const uniqueDates = Array.from(new Set(stats[k].dates)).sort();
            return { content: k, count: stats[k].count, dates: uniqueDates };
        }).sort((a, b) => b.count - a.count || a.content.localeCompare(b.content));
        res.json({ success: true, items });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取失败' });
    }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
});
