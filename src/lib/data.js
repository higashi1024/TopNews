import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

function listDates(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => DATE_FILE.test(f)).map((f) => f.replace(".json", "")).sort().reverse();
}

// 最新の1日分（話題キーワード・商品・ニュース）
export function loadLatest() {
  const dates = listDates(DATA_DIR);
  if (dates.length === 0) throw new Error("data/ に日付ファイルがありません");
  const json = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${dates[0]}.json`), "utf8"));
  return json;
}

// 履歴（話題キーワードのみ。毎日の最終状態を保存したもの）
export function loadArchive() {
  return listDates(ARCHIVE_DIR).map((date) => ({
    date,
    ...JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, `${date}.json`), "utf8")),
  }));
}
