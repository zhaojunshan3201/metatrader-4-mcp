import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { promisify } from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// MT4 data directory - configure this path for your MT4 installation
const MT4_DATA_PATH =
  process.env.MT4_DATA_PATH ||
  path.join(process.env.APPDATA || "", "MetaQuotes", "Terminal");

// MT4 installation path for MetaEditor
const MT4_INSTALL_PATH =
  process.env.MT4_INSTALL_PATH ||
  path.join(MT4_DATA_PATH, "metaeditor.exe");

// Alternative paths to try for MetaEditor
const METAEDITOR_PATHS = [
  MT4_INSTALL_PATH,
  "C:\\Program Files (x86)\\MetaTrader 4\\metaeditor.exe",
  "C:\\Program Files\\MetaTrader 4\\metaeditor.exe",
].filter(Boolean);
const MT4_TERMINAL_PATH =
  process.env.MT4_TERMINAL_PATH ||
  path.join(MT4_DATA_PATH, "terminal.exe");
const BACKTEST_WORK_DIR =
  process.env.MT4_BACKTEST_WORK_DIR || path.join(__dirname, "backtests");
const BACKTEST_TIMEOUT_MS = Number(process.env.MT4_BACKTEST_TIMEOUT_MS || 180000);
const REPORTS_DIR =
  process.env.MT4_REPORTS_PATH ||
  path.join(MT4_DATA_PATH, "MQL4", "Files", "mt4_reports");
let lastBacktestStatus = {
  status: "idle",
  message: "No bridge-launched backtest has run yet",
};

app.use(cors());
app.use(express.json());

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function updateBacktestStatus(status) {
  lastBacktestStatus = {
    ...lastBacktestStatus,
    ...status,
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(path.join(REPORTS_DIR, "backtest_status.json"), lastBacktestStatus);
}

function normalizeDate(dateValue) {
  return String(dateValue || "").replace(/-/g, ".");
}

function mapTesterModel(model) {
  const value = String(model || "Every tick").toLowerCase();
  if (value.includes("open")) return 2;
  if (value.includes("control")) return 1;
  return 0;
}

function mapTesterPeriod(timeframe) {
  const value = String(timeframe || "M15").toUpperCase();
  const allowed = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]);
  return allowed.has(value) ? value : "M15";
}

function sanitizeFilePart(value) {
  return String(value || "backtest").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function readTextSmart(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }
  const utf8 = buffer.toString("utf8");
  if (utf8.includes("\u0000")) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  if (utf8.includes("\uFFFD")) {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch (error) {
      return new TextDecoder("gbk").decode(buffer);
    }
  }
  return utf8;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function parseNumber(value) {
  const cleaned = String(value || "").replace(/,/g, "").replace(/%/g, "").trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function extractMetric(reportText, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}(?:\\s*\\([^)]*\\))?\\s+(-?\\d[\\d,.]*(?:\\s*%)?)`, "i");
    const match = reportText.match(regex);
    if (match) return parseNumber(match[1]);
  }
  return null;
}

async function parseBacktestReport(reportFile) {
  const html = await readTextSmart(reportFile);
  const text = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();

  const result = {
    report_file: reportFile,
    generated_at: new Date().toISOString(),
    net_profit: extractMetric(text, ["Total net profit", "Total Net Profit", "总净盈利"]),
    gross_profit: extractMetric(text, ["Gross profit", "Gross Profit", "总获利"]),
    gross_loss: extractMetric(text, ["Gross loss", "Gross Loss", "总亏损"]),
    profit_factor: extractMetric(text, ["Profit factor", "Profit Factor", "盈利比"]),
    expected_payoff: extractMetric(text, ["Expected payoff", "Expected Payoff", "预期盈利"]),
    absolute_drawdown: extractMetric(text, ["Absolute drawdown", "Absolute Drawdown", "绝对亏损"]),
    maximal_drawdown: extractMetric(text, ["Maximal drawdown", "Maximal Drawdown", "最大亏损"]),
    relative_drawdown_percent: extractMetric(text, ["Relative drawdown", "Relative Drawdown", "相对亏损"]),
    total_trades: extractMetric(text, ["Total trades", "Total Trades", "交易单总计"]),
    short_positions: extractMetric(text, ["Short positions", "Short Positions", "卖单"]),
    long_positions: extractMetric(text, ["Long positions", "Long Positions", "买单"]),
    modeling_quality: extractMetric(text, ["Modelling quality", "Modeling quality", "复盘模型的质量"]),
  };
  return result;
}

async function writeSetFile(filePath, parameters = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(parameters || {})) {
    lines.push(`${key}=${value}`);
    lines.push(`${key},F=0`);
    lines.push(`${key},1=${value}`);
    lines.push(`${key},2=0`);
    lines.push(`${key},3=0`);
  }
  await fs.writeFile(filePath, lines.join("\r\n") + "\r\n", "utf-8");
}

async function prepareBacktestExpert(expertName) {
  const sourceExpertsDir = await findMT4ExpertsDirectory();
  const backtestRoot = path.dirname(MT4_TERMINAL_PATH);
  const targetExpertsDir = path.join(backtestRoot, "MQL4", "Experts");
  await fs.mkdir(targetExpertsDir, { recursive: true });

  for (const ext of [".mq4", ".ex4"]) {
    const src = path.join(sourceExpertsDir, `${expertName}${ext}`);
    const dst = path.join(targetExpertsDir, `${expertName}${ext}`);
    try {
      await fs.copyFile(src, dst);
    } catch (error) {
      // It is valid for an EA to have only source or only compiled output.
    }
  }
}

async function runTerminalBacktest(configPath, reportFile) {
  await fs.access(MT4_TERMINAL_PATH);
  return new Promise((resolve) => {
    const args = ["/portable", configPath];
    const terminalRoot = path.dirname(MT4_TERMINAL_PATH);
    const startedAt = Date.now();
    const terminal = spawn(MT4_TERMINAL_PATH, args, {
      cwd: terminalRoot,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;
    terminal.stdout?.on("data", (data) => (stdout += data.toString()));
    terminal.stderr?.on("data", (data) => (stderr += data.toString()));

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve({ stdout, stderr, elapsed_ms: Date.now() - startedAt, ...payload });
    };

    terminal.on("error", (error) => finish({ success: false, error: error.message }));
    terminal.on("close", async (code) => {
      try {
        await fs.access(reportFile);
        finish({ success: true, exit_code: code, report_file: reportFile });
      } catch (error) {
        finish({ success: false, exit_code: code, error: "Terminal exited before report was created" });
      }
    });

    const poll = setInterval(async () => {
      try {
        const stats = await fs.stat(reportFile);
        if (stats.size > 0) finish({ success: true, exit_code: null, report_file: reportFile });
      } catch (error) {
        // Keep polling.
      }
    }, 2000);

    const timeout = setTimeout(() => {
      try {
        terminal.kill();
      } catch (error) {
        // Dedicated backtest terminal; safe to stop on timeout.
      }
      finish({ success: false, exit_code: null, error: `Backtest timed out after ${BACKTEST_TIMEOUT_MS}ms` });
    }, BACKTEST_TIMEOUT_MS);
  });
}

async function getMT4Mql4Roots() {
  const directRoot = path.join(MT4_DATA_PATH, "MQL4");
  try {
    await fs.access(directRoot);
    return [directRoot];
  } catch (err) {
    // Continue with MetaQuotes terminal-hash layout below.
  }

  const terminalFolders = await fs.readdir(MT4_DATA_PATH);
  const roots = [];
  for (const folder of terminalFolders) {
    if (folder.length === 32) {
      const mql4Root = path.join(MT4_DATA_PATH, folder, "MQL4");
      try {
        await fs.access(mql4Root);
        roots.push(mql4Root);
      } catch (err) {
        continue;
      }
    }
  }
  return roots;
}

// Helper function to read MT4 files
async function readMT4File(filename) {
  try {
    const mql4Roots = await getMT4Mql4Roots();

    for (const mql4Root of mql4Roots) {
      const filePath = path.join(mql4Root, "Files", filename);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return content.trim();
      } catch (err) {
        continue;
      }
    }
    throw new Error(`File ${filename} not found in any terminal folder`);
  } catch (error) {
    throw new Error(`Failed to read MT4 file ${filename}: ${error.message}`);
  }
}

// Helper function to write MT4 files
async function writeMT4File(filename, content) {
  try {
    const mql4Roots = await getMT4Mql4Roots();
    let written = false;

    for (const mql4Root of mql4Roots) {
      const filesDir = path.join(mql4Root, "Files");
      try {
        await fs.mkdir(filesDir, { recursive: true });
        const filePath = path.join(filesDir, filename);
        await fs.writeFile(filePath, content, "utf-8");
        written = true;
        break;
      } catch (err) {
        continue;
      }
    }

    if (!written) {
      throw new Error("No writable terminal folder found");
    }
  } catch (error) {
    throw new Error(`Failed to write MT4 file ${filename}: ${error.message}`);
  }
}

// Helper function to find MT4 Experts directory
async function findMT4ExpertsDirectory() {
  try {
    const mql4Roots = await getMT4Mql4Roots();

    for (const mql4Root of mql4Roots) {
      const expertsPath = path.join(mql4Root, "Experts");
      try {
        await fs.access(expertsPath);
        return expertsPath;
      } catch (err) {
        continue;
      }
    }

    throw new Error("No MT4 Experts directory found");
  } catch (error) {
    throw new Error(`Failed to find MT4 Experts directory: ${error.message}`);
  }
}

// Helper function to find MetaEditor executable
async function findMetaEditor() {
  for (const editorPath of METAEDITOR_PATHS) {
    try {
      await fs.access(editorPath);
      return editorPath;
    } catch (err) {
      continue;
    }
  }
  throw new Error(
    "MetaEditor not found. Please set MT4_INSTALL_PATH environment variable."
  );
}

// Helper function to compile EA using MetaEditor
async function compileEA(eaPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const metaEditorPath = await findMetaEditor();
      const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      const compileDir = path.join(__dirname, "compile-temp");
      await fs.mkdir(compileDir, { recursive: true });
      const tempEaPath = path.join(compileDir, path.basename(eaPath));
      await fs.copyFile(eaPath, tempEaPath);
      const logFile = path.join(
        compileDir,
        `${path.basename(eaPath, ".mq4")}_compile.log`
      );

      const incPath = `${path.dirname(eaPath)}\\..\\Include`;
      const psScript = [
        `$metaEditor = ${psQuote(metaEditorPath)};`,
        `$eaPath = ${psQuote(tempEaPath)};`,
        `$logFile = ${psQuote(logFile)};`,
        `$incPath = ${psQuote(incPath)};`,
        "Remove-Item -LiteralPath $logFile -ErrorAction SilentlyContinue;",
        "$p = Start-Process -FilePath $metaEditor -ArgumentList @('/compile:' + $eaPath, '/log:' + $logFile, '/inc:' + $incPath) -Wait -PassThru -WindowStyle Hidden;",
        "if ($null -ne $p.ExitCode) { exit $p.ExitCode } else { exit 0 }",
      ].join(" ");

      // MetaEditor is more reliable on Windows when launched via Start-Process -Wait.
      const compiler = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psScript,
      ]);

      let stdout = "";
      let stderr = "";

      compiler.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      compiler.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      compiler.on("close", async (code) => {
        try {
          // Read compilation log if it exists
          let logContent = "";
          try {
            logContent = await fs.readFile(logFile, "utf-8");
          } catch (logErr) {
            logContent = "Compilation log not available";
          }

          // Check if .ex4 file was created in the temp compile folder,
          // then copy it back into MT4 Experts.
          const tempEx4Path = tempEaPath.replace(".mq4", ".ex4");
          const ex4Path = eaPath.replace(".mq4", ".ex4");
          let compiled = false;
          try {
            await fs.access(tempEx4Path);
            await fs.copyFile(tempEx4Path, ex4Path);
            compiled = true;
          } catch (ex4Err) {
            // .ex4 not created, compilation likely failed
          }

          // Parse log for errors and warnings
          const errors = (logContent.match(/\d+ error\(s\)/gi) || [
            "0 error(s)",
          ])[0];
          const warnings = (logContent.match(/\d+ warning\(s\)/gi) || [
            "0 warning(s)",
          ])[0];

          const errorCount = parseInt(errors.match(/\d+/)[0]) || 0;
          const warningCount = parseInt(warnings.match(/\d+/)[0]) || 0;

          resolve({
            success: errorCount === 0,
            compiled: compiled,
            exit_code: code,
            errors: errorCount,
            warnings: warningCount,
            log: logContent,
            stdout: stdout,
            stderr: stderr,
            ex4_path: compiled ? ex4Path : null,
            log_file: logFile,
          });
        } catch (parseError) {
          reject(
            new Error(
              `Failed to parse compilation results: ${parseError.message}`
            )
          );
        }
      });

      compiler.on("error", (error) => {
        reject(new Error(`Failed to start MetaEditor: ${error.message}`));
      });

      // Set timeout for compilation
      setTimeout(() => {
        compiler.kill();
        reject(new Error("Compilation timeout after 30 seconds"));
      }, 30000);
    } catch (error) {
      reject(error);
    }
  });
}

// API Routes

// Get account information
app.get("/api/account", async (req, res) => {
  try {
    const accountData = await readMT4File("account_info.txt");
    const lines = accountData.split("\\n");
    const info = {};

    for (const line of lines) {
      const [key, value] = line.split("=");
      if (key && value) {
        info[key.trim()] = value.trim();
      }
    }

    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get market data for a symbol
app.get("/api/market/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const marketData = await readMT4File(`market_data_${symbol}.txt`);
    const lines = marketData.split("\\n");
    const data = {};

    for (const line of lines) {
      const [key, value] = line.split("=");
      if (key && value) {
        data[key.trim()] = value.trim();
      }
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place an order
app.post("/api/order", async (req, res) => {
  try {
    const orderCommand = {
      action: "PLACE_ORDER",
      ...req.body,
      timestamp: Date.now(),
    };

    await writeMT4File("order_commands.txt", JSON.stringify(orderCommand));

    // Wait a moment for MT4 to process and read the result
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const result = await readMT4File("order_result.txt");
      res.json({ success: true, result: JSON.parse(result) });
    } catch (err) {
      res.json({ success: true, message: "Order command sent to MT4" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get open positions
app.get("/api/positions", async (req, res) => {
  try {
    const positionsData = await readMT4File("positions.txt");
    const lines = positionsData.split("\\n");
    const positions = [];
    let currentPosition = {};

    for (const line of lines) {
      if (line === "---") {
        if (Object.keys(currentPosition).length > 0) {
          positions.push(currentPosition);
          currentPosition = {};
        }
      } else if (line.includes("=")) {
        const [key, value] = line.split("=");
        if (key && value) {
          currentPosition[key.trim()] = value.trim();
        }
      }
    }

    if (Object.keys(currentPosition).length > 0) {
      positions.push(currentPosition);
    }

    res.json({ positions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Close a position
app.post("/api/close", async (req, res) => {
  try {
    const closeCommand = {
      action: "CLOSE_POSITION",
      ticket: req.body.ticket,
      timestamp: Date.now(),
    };

    await writeMT4File("close_commands.txt", JSON.stringify(closeCommand));

    // Wait for MT4 to process
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const result = await readMT4File("close_result.txt");
      res.json({ success: true, result: JSON.parse(result) });
    } catch (err) {
      res.json({ success: true, message: "Close command sent to MT4" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trading history
app.get("/api/history", async (req, res) => {
  try {
    const days = req.query.days || 7;
    const historyData = await readMT4File(`history_${days}d.txt`);
    const lines = historyData.split("\\n");
    const history = [];
    let currentTrade = {};

    for (const line of lines) {
      if (line === "---") {
        if (Object.keys(currentTrade).length > 0) {
          history.push(currentTrade);
          currentTrade = {};
        }
      } else if (line.includes("=")) {
        const [key, value] = line.split("=");
        if (key && value) {
          currentTrade[key.trim()] = value.trim();
        }
      }
    }

    if (Object.keys(currentTrade).length > 0) {
      history.push(currentTrade);
    }

    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run backtest
app.post("/api/backtest", async (req, res) => {
  try {
    const runId = `${Date.now()}_${sanitizeFilePart(req.body.expert)}_${sanitizeFilePart(req.body.symbol)}_${sanitizeFilePart(req.body.timeframe)}`;
    const runDir = path.join(BACKTEST_WORK_DIR, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(REPORTS_DIR, { recursive: true });

    const backtestRoot = path.dirname(MT4_TERMINAL_PATH);
    const testerDir = path.join(backtestRoot, "tester");
    const testerReportsDir = path.join(testerDir, "reports");
    await fs.mkdir(testerDir, { recursive: true });
    await fs.mkdir(testerReportsDir, { recursive: true });

    const reportName = `${runId}_report`;
    const reportBase = path.join(testerReportsDir, reportName);
    const reportFile = `${reportBase}.htm`;
    const setFileName = `${runId}_inputs.set`;
    const setFile = path.join(testerDir, setFileName);
    const configFile = path.join(runDir, "tester.ini");
    await prepareBacktestExpert(req.body.expert);
    await writeSetFile(setFile, req.body.parameters || {});

    const config = [
      "Login=0",
      "ProxyEnable=false",
      "NewsEnable=false",
      `TestExpert=${req.body.expert}`,
      `TestExpertParameters=${setFileName}`,
      `TestSymbol=${req.body.symbol}`,
      `TestPeriod=${mapTesterPeriod(req.body.timeframe)}`,
      `TestModel=${mapTesterModel(req.body.model)}`,
      "TestSpread=0",
      "TestOptimization=false",
      "TestDateEnable=true",
      `TestFromDate=${normalizeDate(req.body.from_date)}`,
      `TestToDate=${normalizeDate(req.body.to_date)}`,
      `TestDeposit=${Number(req.body.initial_deposit || 10000)}`,
      "TestCurrency=USD",
      `TestReport=tester\\reports\\${reportName}`,
      "TestReplaceReport=true",
      "TestShutdownTerminal=true",
      "",
    ].join("\r\n");
    await fs.writeFile(configFile, config, "utf-8");

    await updateBacktestStatus({
      status: "running",
      run_id: runId,
      expert: req.body.expert,
      symbol: req.body.symbol,
      timeframe: req.body.timeframe,
      from_date: req.body.from_date,
      to_date: req.body.to_date,
      config_file: configFile,
      report_file: reportFile,
      message: "MT4 terminal backtest started",
    });

    const execution = await runTerminalBacktest(configFile, reportFile);
    if (!execution.success) {
      await updateBacktestStatus({
        status: "failed",
        run_id: runId,
        message: execution.error || "Backtest failed",
        execution,
      });
      return res.status(500).json({
        success: false,
        run_id: runId,
        error: execution.error,
        execution,
        config_file: configFile,
        report_file: reportFile,
      });
    }

    const parsed = await parseBacktestReport(reportFile);
    const result = {
      success: true,
      status: "completed",
      run_id: runId,
      expert: req.body.expert,
      symbol: req.body.symbol,
      timeframe: req.body.timeframe,
      from_date: req.body.from_date,
      to_date: req.body.to_date,
      initial_deposit: Number(req.body.initial_deposit || 10000),
      model: req.body.model || "Every tick",
      optimization: Boolean(req.body.optimization),
      config_file: configFile,
      report_file: reportFile,
      execution,
      metrics: parsed,
      timestamp: new Date().toISOString(),
    };

    await writeJsonFile(path.join(REPORTS_DIR, "backtest_results.json"), result);
    await writeJsonFile(path.join(REPORTS_DIR, "backtest_results_detailed.json"), {
      ...result,
      report_text: await readTextSmart(reportFile),
    });
    await fs.copyFile(reportFile, path.join(REPORTS_DIR, "backtest_report.html"));
    await updateBacktestStatus({
      status: "completed",
      run_id: runId,
      message: "Backtest completed and report parsed",
      report_file: reportFile,
      metrics: parsed,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/backtest/status", async (req, res) => {
  try {
    const statusFile = path.join(REPORTS_DIR, "backtest_status.json");
    try {
      const statusData = await fs.readFile(statusFile, "utf-8");
      return res.json(JSON.parse(statusData));
    } catch (error) {
      return res.json(lastBacktestStatus);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get backtest results
app.get("/api/backtest/results", async (req, res) => {
  try {
    const detailed = req.query.detailed === "true";
    const jsonFile = path.join(
      REPORTS_DIR,
      detailed ? "backtest_results_detailed.json" : "backtest_results.json"
    );
    const resultsData = await fs.readFile(jsonFile, "utf-8");

    try {
      const results = JSON.parse(resultsData);
      res.json(results);
    } catch (parseError) {
      // If not JSON, return as text report
      res.json({ report: resultsData });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available Expert Advisors
app.get("/api/experts", async (req, res) => {
  try {
    const expertsData = await readMT4File("experts_list.txt");
    const lines = expertsData.split("\\n").filter((line) => line.trim());
    const experts = lines.map((line) => {
      const parts = line.split("|");
      return {
        name: parts[0]?.trim(),
        description: parts[1]?.trim() || "",
        modified: parts[2]?.trim() || "",
      };
    });

    res.json({ experts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// EA Upload endpoint
app.post("/api/ea/upload", async (req, res) => {
  try {
    const { ea_name, ea_content } = req.body;

    if (!ea_name || !ea_content) {
      return res.status(400).json({
        success: false,
        error: "Missing ea_name or ea_content",
      });
    }

    // Find MT4 Experts directory
    const expertsDir = await findMT4ExpertsDirectory();
    const eaFilePath = path.join(expertsDir, `${ea_name}.mq4`);

    // Write EA file to MT4 Experts directory
    await fs.writeFile(eaFilePath, ea_content, "utf-8");

    // Verify file was written
    const stats = await fs.stat(eaFilePath);

    res.json({
      success: true,
      message: "EA uploaded successfully",
      ea_name: ea_name,
      file_path: eaFilePath,
      file_size: stats.size,
      experts_directory: expertsDir,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("EA Upload Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      mt4_path: MT4_DATA_PATH,
    });
  }
});

// EA Compilation endpoint
app.post("/api/ea/compile", async (req, res) => {
  try {
    const { ea_name } = req.body;

    if (!ea_name) {
      return res.status(400).json({
        success: false,
        error: "Missing ea_name",
      });
    }

    // Find MT4 Experts directory and EA file
    const expertsDir = await findMT4ExpertsDirectory();
    const eaFilePath = path.join(expertsDir, `${ea_name}.mq4`);

    // Check if EA file exists
    try {
      await fs.access(eaFilePath);
    } catch (accessError) {
      return res.status(404).json({
        success: false,
        error: `EA file not found: ${ea_name}.mq4`,
        expected_path: eaFilePath,
      });
    }

    // Compile EA
    console.log(`Starting compilation of ${ea_name}...`);
    const compilationResult = await compileEA(eaFilePath);

    res.json({
      success: compilationResult.success,
      compiled: compilationResult.compiled,
      ea_name: ea_name,
      source_file: eaFilePath,
      ex4_file: compilationResult.ex4_path,
      errors: compilationResult.errors,
      warnings: compilationResult.warnings,
      exit_code: compilationResult.exit_code,
      log: compilationResult.log,
      log_file: compilationResult.log_file,
      timestamp: new Date().toISOString(),
      message: compilationResult.success
        ? "EA compiled successfully"
        : `Compilation failed with ${compilationResult.errors} error(s)`,
    });
  } catch (error) {
    console.error("EA Compilation Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      ea_name: req.body.ea_name,
    });
  }
});

// List EA files in Experts directory
app.get("/api/ea/list", async (req, res) => {
  try {
    const expertsDir = await findMT4ExpertsDirectory();
    const files = await fs.readdir(expertsDir);

    const eaFiles = [];
    for (const file of files) {
      if (file.endsWith(".mq4") || file.endsWith(".ex4")) {
        const filePath = path.join(expertsDir, file);
        const stats = await fs.stat(filePath);
        eaFiles.push({
          name: file,
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          type: file.endsWith(".mq4") ? "source" : "compiled",
        });
      }
    }

    res.json({
      success: true,
      experts_directory: expertsDir,
      files: eaFiles,
      count: eaFiles.length,
    });
  } catch (error) {
    console.error("EA List Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get MetaEditor status and path
app.get("/api/ea/metaeditor", async (req, res) => {
  try {
    const metaEditorPath = await findMetaEditor();
    const expertsDir = await findMT4ExpertsDirectory();

    res.json({
      success: true,
      metaeditor_path: metaEditorPath,
      experts_directory: expertsDir,
      mt4_data_path: MT4_DATA_PATH,
      available_paths: METAEDITOR_PATHS,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      mt4_data_path: MT4_DATA_PATH,
      searched_paths: METAEDITOR_PATHS,
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mt4_path: MT4_DATA_PATH,
    features: [
      "account_info",
      "market_data",
      "orders",
      "positions",
      "history",
      "backtesting",
      "ea_upload",
      "ea_compilation",
    ],
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MT4 HTTP Bridge running on http://0.0.0.0:${PORT}`);
  console.log(`MT4 Data Path: ${MT4_DATA_PATH}`);
  console.log(
    "Make sure MT4 is running with the MCPBridge Expert Advisor attached to a chart"
  );
});
