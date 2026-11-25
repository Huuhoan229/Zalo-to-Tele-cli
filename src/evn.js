// EVN CSKH (cskh.evn.com.vn unified portal & mobile app + regional gateways)
// client, 6-tier residential tariff calculator, report formatter, and Vietnam-time schedule helper.
import crypto from 'node:crypto';

export const EVN_RESIDENTIAL_TIERS = [
  { tier: 1, label: 'Bậc 1 (0-50 kWh)', min: 0, max: 50, price: 1984 },
  { tier: 2, label: 'Bậc 2 (51-100 kWh)', min: 50, max: 100, price: 2050 },
  { tier: 3, label: 'Bậc 3 (101-200 kWh)', min: 100, max: 200, price: 2380 },
  { tier: 4, label: 'Bậc 4 (201-300 kWh)', min: 200, max: 300, price: 2998 },
  { tier: 5, label: 'Bậc 5 (301-400 kWh)', min: 300, max: 400, price: 3350 },
  { tier: 6, label: 'Bậc 6 (401+ kWh)', min: 400, max: Infinity, price: 3460 },
];

export const EVN_VAT_PERCENT = 8;

const CSKHEVN_BASE_URL = 'https://cskh.evn.com.vn/cskh/v1';
const CSKHEVN_TCT_GATEWAYS = {
  HN: 'https://gwkong.evnhanoi.vn',
  PD: 'https://gwkong.evnhanoi.vn',
  PA: 'https://apicskhevn.npc.com.vn',
  NPC: 'https://apicskhevn.npc.com.vn',
  PC: 'https://cskh-api.cpc.vn',
  CPC: 'https://cskh-api.cpc.vn',
  PB: 'https://api.cskh.evnspc.vn/api-cskh-evn',
  SPC: 'https://api.cskh.evnspc.vn/api-cskh-evn',
  PE: 'https://openapi.evnhcmc.vn/evn-ttcskh/appcskh',
  HCM: 'https://openapi.evnhcmc.vn/evn-ttcskh/appcskh',
};

const EVNHANOI_LOGIN_URLS = [
  'https://apicskh.evnhanoi.vn/connect/token',
  'https://apicskh.evnhanoi.com.vn/connect/token',
];
const EVNHANOI_DATA_URL = 'https://evnhanoi.vn/api/TraCuu/LayChiSoDoXa';
const EVNHANOI_PAYMENT_URL = 'https://evnhanoi.vn/api/TraCuu/GetListThongTinNoKhachHang';

const EVNNPC_LOGIN_URL = 'https://billnpccc.enterhub.asia/login';
const EVNNPC_DATA_URL = 'https://billnpccc.enterhub.asia/dailyconsump';
const EVNNPC_PAYMENT_URL = 'https://billnpccc.enterhub.asia/mobileapi/home/';
const EVNNPC_BASIC_AUTH = Buffer.from(
  'A21FA5C-34BE-42D7-AE70-8BF03C1EE540:026A64EF-2A91-4973-AA20-6E8A2B66D560',
).toString('base64');

export function detectEvnArea(customerId) {
  const clean = String(customerId || '').trim().toUpperCase();
  if (/^(PA|PH|PM|PN)/.test(clean)) return 'EVNNPC';
  if (/^(PC|PQ|PP)/.test(clean)) return 'EVNCPC';
  if (/^PE/.test(clean)) return 'EVNHCMC';
  if (/^(PB|PK)/.test(clean)) return 'EVNSPC';
  return 'EVNHANOI';
}

function gatewayForCustomer(customerId, maDviCaptct = '') {
  const tct = String(maDviCaptct || '').trim().toUpperCase();
  if (tct && CSKHEVN_TCT_GATEWAYS[tct]) return CSKHEVN_TCT_GATEWAYS[tct];
  const area = detectEvnArea(customerId);
  if (area === 'EVNNPC') return CSKHEVN_TCT_GATEWAYS.PA;
  if (area === 'EVNCPC') return CSKHEVN_TCT_GATEWAYS.PC;
  if (area === 'EVNHCMC') return CSKHEVN_TCT_GATEWAYS.PE;
  if (area === 'EVNSPC') return CSKHEVN_TCT_GATEWAYS.PB;
  return CSKHEVN_TCT_GATEWAYS.HN;
}

export function getVietnamDateParts(now = new Date()) {
  const vnMs = now.getTime() + 7 * 60 * 60 * 1000;
  const vn = new Date(vnMs);
  const year = vn.getUTCFullYear();
  const month = vn.getUTCMonth() + 1;
  const day = vn.getUTCDate();
  const hour = vn.getUTCHours();
  const minute = vn.getUTCMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year,
    month,
    day,
    hour,
    minute,
    isoDate: `${year}-${pad(month)}-${pad(day)}`,
    dmyDate: `${pad(day)}/${pad(month)}/${year}`,
  };
}

export function computeBillingRange(billingStartDay = 1, now = new Date()) {
  const startDay = Math.min(Math.max(Math.trunc(Number(billingStartDay) || 1), 1), 28);
  const { year, month, day, dmyDate } = getVietnamDateParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  const startDayStr = pad(startDay);
  let fromDate;
  if (day > startDay) {
    fromDate = `${startDayStr}/${pad(month)}/${year}`;
  } else if (month >= 2) {
    fromDate = `${startDayStr}/${pad(month - 1)}/${year}`;
  } else {
    fromDate = `${startDayStr}/12/${year - 1}`;
  }
  return { fromDate, toDate: dmyDate };
}

export function calcElectricityCost(kwh, { vatPercent = EVN_VAT_PERCENT, tiers = EVN_RESIDENTIAL_TIERS } = {}) {
  const totalKwh = Math.max(0, Number(kwh) || 0);
  let subtotal = 0;
  const breakdown = [];
  for (const tier of tiers) {
    if (totalKwh <= tier.min) break;
    const used = Math.min(totalKwh, tier.max) - tier.min;
    const usedRounded = Math.round(used * 100) / 100;
    const amount = Math.round(usedRounded * tier.price);
    subtotal += usedRounded * tier.price;
    breakdown.push({
      tier: tier.tier,
      label: tier.label,
      kwh: usedRounded,
      price: tier.price,
      amount,
    });
  }
  const roundedSubtotal = Math.round(subtotal);
  const vat = Math.round((roundedSubtotal * vatPercent) / 100);
  const total = roundedSubtotal + vat;
  return {
    kwh: Math.round(totalKwh * 100) / 100,
    subtotal: roundedSubtotal,
    vat,
    total,
    tiers: breakdown,
  };
}

function parseDmyString(value) {
  const text = String(value || '').trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (dmy) {
    return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
  }
  const ymd = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(text);
  if (ymd) {
    return new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function formatDmy(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

function shiftDays(date, deltaDays) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + deltaDays * 24 * 60 * 60 * 1000);
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? '').trim().replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Primary flow: Unified EVN CSKH application (https://cskh.evn.com.vn/cskh/v1/auth/login)
 * + regional gateway (e.g. https://gwkong.evnhanoi.vn for EVNHANOI PD...).
 */
async function fetchUnifiedEvnCskh({
  username,
  password,
  customerId,
  fromDate,
  toDate,
  fetchImpl = fetch,
  timeoutMs = 25000,
}) {
  const deviceId = crypto.randomUUID();
  const loginRes = await fetchImpl(`${CSKHEVN_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-deviceId': deviceId,
    },
    body: JSON.stringify({
      deviceInfo: {
        appId: 'CSKHEVN',
        appVersion: 'v1.0.0',
        deviceId,
        deviceType: 'Windows-10/desktop/Chrome',
        clientType: 'WEB',
      },
      email: 'admin@gmail.com',
      expiration: 1000,
      password: String(password),
      username: String(username).trim(),
      userid: String(username).trim(),
      captchaToken: null,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const loginJson = await loginRes.json().catch(() => null);
  const accessToken = loginJson?.data?.accessToken || loginJson?.accessToken;
  if (!loginRes.ok || !loginJson?.success || !accessToken) {
    const errMsg = loginJson?.message || loginJson?.cause || loginJson?.data || `HTTP ${loginRes.status}`;
    throw Object.assign(new Error(`Đăng nhập EVN CSKH thất bại: ${errMsg}`), { authFailed: true });
  }

  let khachHang = loginJson?.data?.data || null;
  let activeToken = accessToken;
  const resolvedCustomerId = (customerId || khachHang?.maKhang || '').trim().toUpperCase();
  if (!resolvedCustomerId) {
    throw new Error('Tài khoản EVN CSKH chưa liên kết mã khách hàng nào.');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Authorization': `Bearer ${activeToken}`,
    'X-deviceId': deviceId,
  };

  // If user specified a different linked customerId than the default one in token, try switching context
  if (khachHang?.maKhang && khachHang.maKhang.toUpperCase() !== resolvedCustomerId) {
    try {
      const switchRes = await fetchImpl(`${CSKHEVN_BASE_URL}/user/swich/${resolvedCustomerId}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const switchJson = await switchRes.json().catch(() => null);
      const nextToken = switchJson?.data?.accessToken || switchJson?.accessToken;
      if (nextToken) {
        activeToken = nextToken;
        headers.Authorization = `Bearer ${activeToken}`;
      }
      if (switchJson?.data?.data) khachHang = switchJson.data.data;
    } catch {
      // Continue with current token
    }
  }

  const tctGateway = gatewayForCustomer(resolvedCustomerId, khachHang?.maDviCaptct);
  let maDdo = `${resolvedCustomerId}001`;
  try {
    const diemDoRes = await fetchImpl(`${tctGateway}/api/evn/customers/diemdo`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const diemDoJson = await diemDoRes.json().catch(() => null);
    const listDdo = Array.isArray(diemDoJson?.data) ? diemDoJson.data : [];
    const matched = listDdo.find((d) => String(d?.MA_KHANG || '').toUpperCase() === resolvedCustomerId) || listDdo[0];
    if (matched?.MA_DDO) maDdo = String(matched.MA_DDO);
  } catch {
    // Fallback to ${resolvedCustomerId}001
  }

  const dnRes = await fetchImpl(`${tctGateway}/api/evn/tracuu/diennangngay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      MA_DDO: maDdo,
      TU_NGAY: fromDate,
      DEN_NGAY: toDate,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const dnJson = await dnRes.json().catch(() => null);
  const dailyList = Array.isArray(dnJson?.data) ? dnJson.data : [];
  if (!dnJson?.success || dailyList.length === 0) {
    throw new Error(`Chưa có dữ liệu điện năng ngày cho mã ${resolvedCustomerId} (${maDdo}) trong kỳ ${fromDate} - ${toDate}.`);
  }

  const first = dailyList[0];
  const last = dailyList[dailyList.length - 1];
  const prev = dailyList.length > 1 ? dailyList[dailyList.length - 2] : null;

  const dailyLatestKwh = Math.max(0, Math.round(parseNumber(last?.DIEN_TTHU) * 100) / 100);
  const dailyPreviousKwh = prev ? Math.max(0, Math.round(parseNumber(prev?.DIEN_TTHU) * 100) / 100) : 0;
  const meterStart = Math.round(parseNumber(first?.CHI_SO) * 100) / 100;
  const sumKwh = Math.round(dailyList.reduce((sum, item) => sum + Math.max(0, parseNumber(item?.DIEN_TTHU)), 0) * 100) / 100;
  const lastBaseChiSo = parseNumber(last?.CHI_SO);
  const meterLatest = lastBaseChiSo > 0
    ? Math.round((lastBaseChiSo + dailyLatestKwh) * 100) / 100
    : Math.round((meterStart + sumKwh) * 100) / 100;
  const monthlyKwh = sumKwh > 0 ? sumKwh : Math.max(0, Math.round((meterLatest - meterStart) * 100) / 100);

  const periodStartDate = String(first?.NGAY_HTHI || first?.NGAY || fromDate);
  const latestUsageDate = String(last?.NGAY_HTHI || last?.NGAY || toDate);
  const previousUsageDate = prev ? String(prev?.NGAY_HTHI || prev?.NGAY || '') : '';

  let paymentStatus = 'Đã thanh toán';
  let unpaidAmount = 0;
  try {
    const payRes = await fetchImpl(`${tctGateway}/api/evn/tracuu/hoadon-thanhtoan`, {
      method: 'POST',
      headers,
      body: JSON.stringify(null),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payJson = await payRes.json().catch(() => null);
    const bills = Array.isArray(payJson?.data) ? payJson.data : [];
    const unpaid = bills.filter((b) => b?.TTRANG_TTOAN === 'CHUATT' || b?.TTRANG_TTOAN === 'TTOANMOTPHAN' || Number(b?.TONG_NO) > 0);
    if (unpaid.length > 0) {
      paymentStatus = 'Chưa thanh toán';
      unpaidAmount = unpaid.reduce((sum, b) => sum + (parseNumber(b?.TONG_NO || b?.SO_TIEN) || 0), 0);
    }
  } catch {
    // Non-fatal
  }

  return {
    area: detectEvnArea(resolvedCustomerId),
    customerId: resolvedCustomerId,
    customerName: khachHang?.tenKhang || null,
    customerAddress: khachHang?.diaChi || null,
    fromDate: periodStartDate,
    toDate: latestUsageDate,
    latestReadingDate: latestUsageDate,
    previousReadingDate: previousUsageDate,
    meterStart,
    meterLatest,
    dailyLatestKwh,
    dailyPreviousKwh,
    monthlyKwh,
    paymentStatus,
    unpaidAmount,
    readingCount: dailyList.length,
  };
}

async function fetchLegacyEvnHanoi({ username, password, customerId, fromDate, toDate, fetchImpl = fetch, timeoutMs = 25000 }) {
  let loginJson = null;
  let lastStatus = 0;
  for (const loginUrl of EVNHANOI_LOGIN_URLS) {
    try {
      const loginRes = await fetchImpl(loginUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          username: String(username).trim(),
          password: String(password),
          client_id: 'httplocalhost4500',
          client_secret: 'secret',
          grant_type: 'password',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = loginRes.status;
      loginJson = await loginRes.json();
      if (loginJson?.access_token || loginJson?.error) break;
    } catch {
      // Try next login URL
    }
  }

  if (!loginJson) {
    throw new Error(`Không đăng nhập được EVNHANOI (HTTP ${lastStatus}).`);
  }
  if (loginJson?.error === 'invalid_grant' || lastStatus === 400 || lastStatus === 401) {
    throw new Error(`Sai tài khoản hoặc mật khẩu EVNHANOI CSKH (${loginJson?.error_description || 'invalid_grant'}).`);
  }
  const accessToken = loginJson?.access_token;
  if (!accessToken) {
    throw new Error(`EVNHANOI không trả về access_token (HTTP ${lastStatus}).`);
  }

  const authHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  async function queryMeter(suffix) {
    const res = await fetchImpl(EVNHANOI_DATA_URL, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        maDiemDo: `${customerId}${suffix}`,
        maDonVi: customerId.slice(0, 6),
        maXacThuc: 'EVNHN',
        ngayDau: fromDate,
        ngayCuoi: toDate,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  }

  let dataJson = await queryMeter('001');
  if (dataJson?.isError && Number(dataJson?.code) === 400) {
    dataJson = await queryMeter('1');
  }
  if (dataJson?.isError) {
    throw new Error(`EVNHANOI từ chối tra cứu mã khách hàng ${customerId}: ${dataJson?.message || dataJson?.code || 'Lỗi không xác định'}`);
  }

  const readings = Array.isArray(dataJson?.data?.chiSoNgay) ? dataJson.data.chiSoNgay : [];
  if (readings.length === 0) {
    throw new Error(`Chưa có dữ liệu chỉ số công tơ đo xa cho mã ${customerId} trong kỳ ${fromDate} - ${toDate}.`);
  }

  const first = readings[0];
  const last = readings[readings.length - 1];
  const prev = readings.length > 1 ? readings[readings.length - 2] : first;
  const prev2 = readings.length > 2 ? readings[readings.length - 3] : prev;

  const meterStart = Math.round(parseNumber(first?.sg) * 100) / 100;
  const meterLatest = Math.round(parseNumber(last?.sg) * 100) / 100;
  const dailyLatestKwh = Math.max(0, Math.round((parseNumber(last?.sg) - parseNumber(prev?.sg)) * 100) / 100);
  const dailyPreviousKwh = readings.length > 2
    ? Math.max(0, Math.round((parseNumber(prev?.sg) - parseNumber(prev2?.sg)) * 100) / 100)
    : 0;
  const monthlyKwh = Math.max(0, Math.round((meterLatest - meterStart) * 100) / 100);

  const firstDateObj = parseDmyString(first?.ngay);
  const lastDateObj = parseDmyString(last?.ngay);
  const prevDateObj = parseDmyString(prev?.ngay);
  const latestUsageDate = formatDmy(shiftDays(lastDateObj, -1)) || String(last?.ngay || toDate);
  const previousUsageDate = readings.length > 2
    ? (formatDmy(shiftDays(prevDateObj, -1)) || String(prev?.ngay || ''))
    : '';
  const periodStartDate = formatDmy(firstDateObj) || String(first?.ngay || fromDate);

  let paymentStatus = 'Đã thanh toán';
  let unpaidAmount = 0;
  try {
    const payRes = await fetchImpl(EVNHANOI_PAYMENT_URL, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        maKhachHang: customerId,
        maDonViQuanLy: customerId.slice(0, 6),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payJson = await payRes.json();
    const list = payJson?.data?.listThongTinNoKhachHangVm;
    if (!payJson?.isError && Array.isArray(list) && list.length > 0) {
      paymentStatus = 'Chưa thanh toán';
      unpaidAmount = list.reduce((sum, item) => {
        const amount = Number(String(item?.tongTien || '0').replace(/\./g, '').replace(/,/g, '')) || 0;
        return sum + amount;
      }, 0);
    }
  } catch {
    // Non-fatal
  }

  return {
    area: 'EVNHANOI',
    customerId,
    fromDate: periodStartDate,
    toDate: latestUsageDate,
    latestReadingDate: latestUsageDate,
    previousReadingDate: previousUsageDate,
    meterStart,
    meterLatest,
    dailyLatestKwh,
    dailyPreviousKwh,
    monthlyKwh,
    paymentStatus,
    unpaidAmount,
    readingCount: readings.length,
  };
}

async function fetchLegacyEvnNpc({ username, password, customerId, fromDate, toDate, fetchImpl = fetch, timeoutMs = 25000 }) {
  const loginRes = await fetchImpl(EVNNPC_LOGIN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'NPCApp/1 CFNetwork/1240.0.4 Darwin/20.6.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${EVNNPC_BASIC_AUTH}`,
    },
    body: new URLSearchParams({
      username: String(username).trim(),
      password: String(password),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const loginJson = await loginRes.json().catch(() => null);
  if (!loginJson?.access_token) {
    throw new Error('Sai tài khoản hoặc mật khẩu CSKH EVNNPC.');
  }
  const authHeaders = {
    'User-Agent': 'NPCApp/1 CFNetwork/1240.0.4 Darwin/20.6.0',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${loginJson.access_token}`,
  };
  const dataRes = await fetchImpl(EVNNPC_DATA_URL, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      ma: `${customerId}001`,
      start_intime: fromDate.replace(/\//g, '-'),
      stop_intime: toDate.replace(/\//g, '-'),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const list = await dataRes.json();
  const valid = Array.isArray(list)
    ? list.filter((item) => item?.GHI_CHU === 'Sản lượng điện tiêu thụ của khách hàng' && item?.LOAI_CHI_SO === 'P')
    : [];
  if (valid.length === 0) {
    throw new Error(`Chưa có dữ liệu chỉ số ngày cho mã ${customerId} trên EVNNPC.`);
  }
  const latest = valid[0];
  const prev = valid.length > 1 ? valid[1] : latest;
  const oldest = valid[valid.length - 1];
  const meterStart = Math.round(parseNumber(oldest?.CHI_SO_BAT_DAU) * 100) / 100;
  const meterLatest = Math.round(parseNumber(latest?.CHI_SO_KET_THUC) * 100) / 100;
  const dailyLatestKwh = Math.round(parseNumber(latest?.SAN_LUONG) * 100) / 100;
  const dailyPreviousKwh = valid.length > 1 ? Math.round(parseNumber(prev?.SAN_LUONG) * 100) / 100 : 0;
  const monthlyKwh = Math.max(0, Math.round((meterLatest - meterStart) * 100) / 100);
  const latestUsageDate = formatDmy(parseDmyString(latest?.THOI_GIAN_BAT_DAU)) || String(latest?.THOI_GIAN_BAT_DAU || toDate);
  const previousUsageDate = valid.length > 1
    ? (formatDmy(parseDmyString(prev?.THOI_GIAN_BAT_DAU)) || String(prev?.THOI_GIAN_BAT_DAU || ''))
    : '';
  const periodStartDate = formatDmy(parseDmyString(oldest?.THOI_GIAN_BAT_DAU)) || fromDate;

  let paymentStatus = 'Đã thanh toán';
  let unpaidAmount = 0;
  try {
    const payRes = await fetchImpl(`${EVNNPC_PAYMENT_URL}${customerId}`, {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payJson = await payRes.json();
    const invoice = payJson?.data?.customerInfo?.invoice?.[0];
    if (invoice && !invoice.paid) {
      paymentStatus = 'Chưa thanh toán';
      unpaidAmount = Number(invoice.paymentTotalAmount) || 0;
    }
  } catch {
    // Non-fatal
  }

  return {
    area: 'EVNNPC',
    customerId,
    fromDate: periodStartDate,
    toDate: latestUsageDate,
    latestReadingDate: latestUsageDate,
    previousReadingDate: previousUsageDate,
    meterStart,
    meterLatest,
    dailyLatestKwh,
    dailyPreviousKwh,
    monthlyKwh,
    paymentStatus,
    unpaidAmount,
    readingCount: valid.length,
  };
}

export async function fetchEvnUsage({
  username,
  password,
  customerId,
  billingStartDay = 1,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 12000,
} = {}) {
  const cleanCustomerId = String(customerId || '').trim().toUpperCase();
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  if (!cleanUser || !cleanPass || !cleanCustomerId) {
    throw new Error('Chưa cấu hình đủ tài khoản EVN (username, password, mã khách hàng PD...). Dùng /evnset hoặc biến môi trường EVN_USERNAME, EVN_PASSWORD, EVN_CUSTOMER_ID.');
  }
  const { fromDate, toDate } = computeBillingRange(billingStartDay, now);
  const area = detectEvnArea(cleanCustomerId);

  let raw;
  try {
    raw = await fetchUnifiedEvnCskh({
      username: cleanUser,
      password: cleanPass,
      customerId: cleanCustomerId,
      fromDate,
      toDate,
      fetchImpl,
      timeoutMs,
    });
  } catch (unifiedError) {
    const isTimeout = unifiedError?.name === 'TimeoutError' || unifiedError?.name === 'AbortError' || /aborted|timeout/i.test(String(unifiedError?.message || ''));
    if (isTimeout) {
      throw new Error('Máy chủ Koyeb (IP quốc tế) kết nối tới EVN CSKH bị quá thời gian chờ (do EVN chặn IP ngoài Việt Nam).');
    }
    if (!unifiedError?.authFailed) {
      throw unifiedError;
    }
    try {
      raw = area === 'EVNNPC'
        ? await fetchLegacyEvnNpc({ username: cleanUser, password: cleanPass, customerId: cleanCustomerId, fromDate, toDate, fetchImpl, timeoutMs })
        : await fetchLegacyEvnHanoi({ username: cleanUser, password: cleanPass, customerId: cleanCustomerId, fromDate, toDate, fetchImpl, timeoutMs });
    } catch {
      throw unifiedError;
    }
  }

  const monthlyCost = calcElectricityCost(raw.monthlyKwh);
  const prevMonthKwh = Math.max(0, raw.monthlyKwh - raw.dailyLatestKwh);
  const prevMonthCost = calcElectricityCost(prevMonthKwh);
  const dailyLatestCost = Math.max(0, monthlyCost.total - prevMonthCost.total);

  return {
    ...raw,
    billingStartDay: Number(billingStartDay) || 1,
    dailyLatestCost,
    monthlyCost,
    fetchedAt: now.toISOString(),
  };
}

export function formatVnd(amount) {
  const num = Math.round(Number(amount) || 0);
  return `${num.toLocaleString('vi-VN').replace(/,/g, '.')} đ`;
}

export function formatEvnReport(report) {
  const diff = Math.round((report.dailyLatestKwh - (report.dailyPreviousKwh || 0)) * 100) / 100;
  const diffSign = diff > 0 ? `+${diff}` : `${diff}`;
  const compareLine = report.previousReadingDate
    ? `\n↕️ So với ngày ${report.previousReadingDate} (${report.dailyPreviousKwh} kWh): ${diffSign} kWh`
    : '';
  const tierLines = (report.monthlyCost?.tiers || []).map(
    (t) => `  • ${t.label}: ${t.kwh} kWh × ${formatVnd(t.price)} = ${formatVnd(t.amount)}`,
  );
  if (report.monthlyCost?.vat) {
    tierLines.push(`  • Thuế VAT (${EVN_VAT_PERCENT}%): ${formatVnd(report.monthlyCost.vat)}`);
  }
  const debtLine = report.unpaidAmount > 0 || report.paymentStatus === 'Chưa thanh toán'
    ? `⚠️ Chưa thanh toán (${formatVnd(report.unpaidAmount)})`
    : '✅ Đã thanh toán';

  return [
    `⚡ BÁO CÁO ĐIỆN NĂNG ${report.area || 'EVN'}`,
    `Mã KH: ${report.customerId}${report.customerName ? ` (${report.customerName})` : ''}`,
    ...(report.customerAddress ? [`Địa chỉ: ${report.customerAddress}`] : []),
    `Kỳ tính: ${report.fromDate} → ${report.toDate}`,
    '',
    `📅 Ngày gần nhất (${report.latestReadingDate}): ${report.dailyLatestKwh} kWh (~${formatVnd(report.dailyLatestCost)})${compareLine}`,
    '',
    `📊 Tổng điện từ đầu kỳ: ${report.monthlyKwh} kWh`,
    `🔢 Chỉ số công tơ: ${report.meterStart} → ${report.meterLatest} kWh`,
    `💰 Tổng tiền tạm tính (gồm ${EVN_VAT_PERCENT}% VAT): ${formatVnd(report.monthlyCost?.total || 0)}`,
    ...(tierLines.length ? tierLines : []),
    '',
    `🧾 Hóa đơn kỳ trước: ${debtLine}`,
  ].join('\n');
}
