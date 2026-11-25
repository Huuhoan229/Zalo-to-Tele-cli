import { getVietnamDateParts } from './evn.js';

export const DEFAULT_WEATHER_LOCATION = {
  name: 'Hà Nội',
  latitude: 21.0285,
  longitude: 105.8542,
};

export const PRESET_VIETNAM_LOCATIONS = [
  { key: 'hanoi', aliases: ['hn', 'ha noi', 'hà nội', 'hanoi', 'thủ đô hà nội'], name: 'Hà Nội', latitude: 21.0285, longitude: 105.8542 },
  { key: 'duongnoi', aliases: ['duong noi', 'dương nội', 'ha dong', 'hà đông', 'dương nội hà đông'], name: 'Dương Nội, Hà Đông, Hà Nội', latitude: 20.9815, longitude: 105.7515 },
  { key: 'caugiay', aliases: ['cau giay', 'cầu giấy'], name: 'Cầu Giấy, Hà Nội', latitude: 21.0362, longitude: 105.7906 },
  { key: 'namtuliem', aliases: ['nam tu liem', 'nam từ liêm', 'my dinh', 'mỹ đình'], name: 'Nam Từ Liêm, Hà Nội', latitude: 21.0133, longitude: 105.7647 },
  { key: 'hcm', aliases: ['hcm', 'tphcm', 'tp hcm', 'tp.hcm', 'sai gon', 'sài gòn', 'ho chi minh', 'hồ chí minh'], name: 'TP. Hồ Chí Minh', latitude: 10.8231, longitude: 106.6297 },
  { key: 'danang', aliases: ['da nang', 'đà nẵng', 'danang'], name: 'Đà Nẵng', latitude: 16.0544, longitude: 108.2022 },
  { key: 'haiphong', aliases: ['hai phong', 'hải phòng', 'haiphong'], name: 'Hải Phòng', latitude: 20.8449, longitude: 106.6881 },
  { key: 'cantho', aliases: ['can tho', 'cần thơ', 'cantho'], name: 'Cần Thơ', latitude: 10.0452, longitude: 105.7469 },
];

const WMO_WEATHER_LABELS = new Map([
  [0, { icon: '☀️', text: 'Trời quang, nắng đẹp' }],
  [1, { icon: '🌤', text: 'Trời ít mây, nắng nhẹ' }],
  [2, { icon: '⛅', text: 'Có mây rải rác' }],
  [3, { icon: '☁️', text: 'Nhiều mây, âm u' }],
  [45, { icon: '🌫', text: 'Có sương mù' }],
  [48, { icon: '🌫', text: 'Sương mù dày' }],
  [51, { icon: '🌦', text: 'Mưa phùn nhẹ' }],
  [53, { icon: '🌦', text: 'Mưa phùn vừa' }],
  [55, { icon: '🌧', text: 'Mưa phùn dày hạt' }],
  [56, { icon: '🌧', text: 'Mưa phùn lạnh' }],
  [57, { icon: '🌧', text: 'Mưa phùn lạnh nặng hạt' }],
  [61, { icon: '🌦', text: 'Mưa nhỏ' }],
  [63, { icon: '🌧', text: 'Mưa vừa' }],
  [65, { icon: '🌧', text: 'Mưa to' }],
  [66, { icon: '🌧', text: 'Mưa lạnh nhẹ' }],
  [67, { icon: '🌧', text: 'Mưa lạnh to' }],
  [80, { icon: '🌦', text: 'Mưa rào nhẹ' }],
  [81, { icon: '🌧', text: 'Mưa rào vừa' }],
  [82, { icon: '⛈', text: 'Mưa rào to' }],
  [95, { icon: '⛈', text: 'Có dông' }],
  [96, { icon: '⛈', text: 'Mưa dông mạnh' }],
  [99, { icon: '⛈', text: 'Mưa dông rất mạnh' }],
]);

export function describeWeatherCode(code) {
  const numeric = Number(code);
  return WMO_WEATHER_LABELS.get(numeric) || { icon: '🌤', text: 'Có mây' };
}

function normalizeLookup(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function resolveWeatherLocation(query, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const raw = String(query || '').trim();
  if (!raw) return { ...DEFAULT_WEATHER_LOCATION };

  const normalized = normalizeLookup(raw);
  for (const preset of PRESET_VIETNAM_LOCATIONS) {
    if (preset.key === normalized || preset.aliases.some((alias) => normalizeLookup(alias) === normalized)) {
      return {
        name: preset.name,
        latitude: preset.latitude,
        longitude: preset.longitude,
      };
    }
  }

  // Hỗ trợ nhập trực tiếp tọa độ "lat, lon"
  const coordMatch = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(raw);
  if (coordMatch) {
    const latitude = Number(coordMatch[1]);
    const longitude = Number(coordMatch[2]);
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return {
        name: coordMatch[3]?.trim() || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
        latitude,
        longitude,
      };
    }
  }

  // 1. Thử Open-Meteo Geocoding API
  const candidates = [raw];
  if (raw.includes(',')) {
    const firstPart = raw.split(',')[0].trim();
    const lastPart = raw.split(',').at(-1).trim();
    if (firstPart) candidates.push(firstPart);
    if (lastPart && lastPart !== firstPart) candidates.push(lastPart);
  }

  for (const term of candidates) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(term)}&count=5&language=vi&format=json`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        const data = await response.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        const preferred = results.find((item) => item.country_code === 'VN') || results[0];
        if (preferred && Number.isFinite(Number(preferred.latitude)) && Number.isFinite(Number(preferred.longitude))) {
          const labelParts = [preferred.name, preferred.admin1, preferred.country_code === 'VN' ? null : preferred.country]
            .filter(Boolean)
            .filter((val, idx, arr) => arr.indexOf(val) === idx);
          return {
            name: raw.includes(',') ? raw : labelParts.join(', '),
            latitude: Number(preferred.latitude),
            longitude: Number(preferred.longitude),
          };
        }
      }
    } catch {
      // Thử phương án tiếp theo
    }
  }

  // 2. Fallback: OpenStreetMap Nominatim (hỗ trợ tên phường/xã/quận tại Việt Nam rất chi tiết)
  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=vi&countrycodes=vn&q=${encodeURIComponent(raw)}`;
    const response = await fetchImpl(nominatimUrl, {
      headers: { 'user-agent': 'ZaloToTeleWeatherBot/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const list = await response.json();
      const first = Array.isArray(list) ? list[0] : null;
      if (first && Number.isFinite(Number(first.lat)) && Number.isFinite(Number(first.lon))) {
        const shortName = String(first.display_name || raw)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && !/^\d{5,6}$/.test(s) && s.toLowerCase() !== 'việt nam')
          .slice(0, 3)
          .join(', ');
        return {
          name: shortName || raw,
          latitude: Number(first.lat),
          longitude: Number(first.lon),
        };
      }
    }
  } catch {
    // Ignore fallback error
  }

  // 3. Nếu tên có chứa tên tỉnh/thành trong preset (vd: "Quận Hà Đông, Hà Nội")
  for (const preset of PRESET_VIETNAM_LOCATIONS) {
    if (preset.aliases.some((alias) => normalized.includes(normalizeLookup(alias)))) {
      return {
        name: raw,
        latitude: preset.latitude,
        longitude: preset.longitude,
      };
    }
  }

  throw new Error(`Không tìm thấy địa điểm "${raw}". Hãy thử nhập tên Quận/Huyện hoặc Tỉnh/Thành phố (ví dụ: Hà Nội, Dương Nội, Cầu Giấy, Đà Nẵng, TP.HCM).`);
}

function summarizePeriod(hourly, targetDateIso, startHour, endHour) {
  const times = hourly?.time || [];
  const temps = hourly?.temperature_2m || [];
  const rainProbs = hourly?.precipitation_probability || [];
  const codes = hourly?.weather_code || [];

  const matchedTemps = [];
  const matchedRains = [];
  const matchedCodes = [];

  for (let i = 0; i < times.length; i += 1) {
    const timeStr = String(times[i] || '');
    const [datePart, hourPart] = timeStr.split('T');
    if (datePart !== targetDateIso) continue;
    const hour = Number(hourPart?.slice(0, 2));
    if (!Number.isFinite(hour) || hour < startHour || hour > endHour) continue;
    if (Number.isFinite(Number(temps[i]))) matchedTemps.push(Number(temps[i]));
    if (Number.isFinite(Number(rainProbs[i]))) matchedRains.push(Number(rainProbs[i]));
    if (Number.isFinite(Number(codes[i]))) matchedCodes.push(Number(codes[i]));
  }

  if (matchedTemps.length === 0) return null;
  const minTemp = Math.round(Math.min(...matchedTemps));
  const maxTemp = Math.round(Math.max(...matchedTemps));
  const maxRain = matchedRains.length ? Math.round(Math.max(...matchedRains)) : 0;
  // Chọn mã thời tiết đáng chú ý nhất (ưu tiên mã mưa/dông lớn nhất)
  const dominantCode = matchedCodes.length ? Math.max(...matchedCodes) : 0;
  const desc = describeWeatherCode(dominantCode);
  return {
    tempRange: minTemp === maxTemp ? `${maxTemp}°C` : `${minTemp}–${maxTemp}°C`,
    rainProb: maxRain,
    icon: desc.icon,
    text: desc.text,
  };
}

function formatClockTime(isoDateTime) {
  const match = /T(\d{2}:\d{2})/.exec(String(isoDateTime || ''));
  return match ? match[1] : '';
}

function describeUvIndex(uv) {
  const value = Number(uv);
  if (!Number.isFinite(value)) return 'Không rõ';
  if (value < 3) return `${value.toFixed(1)} (Thấp)`;
  if (value < 6) return `${value.toFixed(1)} (Trung bình)`;
  if (value < 8) return `${value.toFixed(1)} (Cao)`;
  if (value < 11) return `${value.toFixed(1)} (Rất cao)`;
  return `${value.toFixed(1)} (Cực cao)`;
}

function buildWeatherAdvice({ minTemp, maxTemp, rainProbMax, rainSum, uvMax }) {
  const tips = [];
  if (rainProbMax >= 60 || rainSum >= 3) {
    tips.push('☔ Khả năng mưa cao, ra ngoài nhớ mang theo ô hoặc áo mưa.');
  } else if (rainProbMax >= 35) {
    tips.push('🌦 Có thể có mưa rải rác trong ngày, nên chuẩn bị sẵn áo mưa/ô.');
  }
  if (minTemp <= 16) {
    tips.push('🧥 Trời lạnh (đặc biệt sáng sớm & đêm), nhớ mặc ấm khi ra đường.');
  } else if (minTemp <= 20) {
    tips.push('🧣 Sáng sớm và tối trời se lạnh, nên khoác thêm áo mỏng.');
  }
  if (maxTemp >= 35) {
    tips.push('🥵 Trưa chiều nắng nóng gay gắt, chú ý uống nhiều nước và hạn chế ra nắng gắt.');
  }
  if (uvMax >= 7) {
    tips.push('🕶 Chỉ số tia UV cao vào buổi trưa, nên đội mũ/đeo kính râm và chống nắng.');
  }
  if (tips.length === 0) {
    tips.push('✨ Thời tiết hôm nay khá dễ chịu, thuận lợi cho công việc và di chuyển.');
  }
  return tips;
}

export async function fetchWeatherForecast({
  locationName = DEFAULT_WEATHER_LOCATION.name,
  latitude = DEFAULT_WEATHER_LOCATION.latitude,
  longitude = DEFAULT_WEATHER_LOCATION.longitude,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : DEFAULT_WEATHER_LOCATION.latitude;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : DEFAULT_WEATHER_LOCATION.longitude;
  const name = String(locationName || DEFAULT_WEATHER_LOCATION.name).trim() || DEFAULT_WEATHER_LOCATION.name;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max' +
    '&timezone=Asia%2FHo_Chi_Minh&forecast_days=2';

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Không lấy được dữ liệu thời tiết (HTTP ${response.status}).`);
  }
  const data = await response.json();
  const vn = getVietnamDateParts(now);
  const daily = data?.daily || {};
  const current = data?.current || {};
  const hourly = data?.hourly || {};

  const todayIso = daily.time?.[0] || vn.isoDate;
  const tomorrowIso = daily.time?.[1] || null;

  const todayCode = daily.weather_code?.[0] ?? current.weather_code ?? 0;
  const currentCode = current.weather_code ?? todayCode;
  const todayDesc = describeWeatherCode(todayCode);
  const currentDesc = describeWeatherCode(currentCode);

  const minTemp = Number(daily.temperature_2m_min?.[0] ?? current.temperature_2m ?? 0);
  const maxTemp = Number(daily.temperature_2m_max?.[0] ?? current.temperature_2m ?? 0);
  const feelsMin = Number(daily.apparent_temperature_min?.[0] ?? minTemp);
  const feelsMax = Number(daily.apparent_temperature_max?.[0] ?? maxTemp);
  const rainProbMax = Number(daily.precipitation_probability_max?.[0] ?? 0);
  const rainSum = Number(daily.precipitation_sum?.[0] ?? 0);
  const uvMax = Number(daily.uv_index_max?.[0] ?? 0);
  const sunrise = formatClockTime(daily.sunrise?.[0]);
  const sunset = formatClockTime(daily.sunset?.[0]);

  const periods = {
    morning: summarizePeriod(hourly, todayIso, 6, 11),
    afternoon: summarizePeriod(hourly, todayIso, 12, 17),
    evening: summarizePeriod(hourly, todayIso, 18, 23),
  };

  let tomorrow = null;
  if (tomorrowIso && daily.temperature_2m_max?.length > 1) {
    const tmDesc = describeWeatherCode(daily.weather_code?.[1] ?? 0);
    tomorrow = {
      dateIso: tomorrowIso,
      displayDate: tomorrowIso.split('-').reverse().join('/'),
      minTemp: Math.round(Number(daily.temperature_2m_min?.[1] ?? 0)),
      maxTemp: Math.round(Number(daily.temperature_2m_max?.[1] ?? 0)),
      rainProbMax: Math.round(Number(daily.precipitation_probability_max?.[1] ?? 0)),
      icon: tmDesc.icon,
      text: tmDesc.text,
    };
  }

  const tips = buildWeatherAdvice({ minTemp, maxTemp, rainProbMax, rainSum, uvMax });

  return {
    locationName: name,
    latitude: lat,
    longitude: lon,
    dateIso: todayIso,
    displayDate: todayIso.split('-').reverse().join('/'),
    current: {
      temperature: Number(current.temperature_2m ?? maxTemp),
      feelsLike: Number(current.apparent_temperature ?? current.temperature_2m ?? maxTemp),
      humidity: Number(current.relative_humidity_2m ?? 0),
      windSpeed: Number(current.wind_speed_10m ?? 0),
      icon: currentDesc.icon,
      text: currentDesc.text,
    },
    today: {
      minTemp,
      maxTemp,
      feelsMin,
      feelsMax,
      rainProbMax,
      rainSum,
      uvMax,
      sunrise,
      sunset,
      icon: todayDesc.icon,
      text: todayDesc.text,
    },
    periods,
    tomorrow,
    tips,
    fetchedAt: new Date(now).toISOString(),
  };
}

export function formatWeatherReport(report) {
  const cur = report.current || {};
  const today = report.today || {};
  const lines = [
    `${today.icon || '🌤'} DỰ BÁO THỜI TIẾT HÔM NAY (${report.displayDate})`,
    `📍 Địa điểm: ${report.locationName}`,
    '',
    `🕒 Hiện tại: ${Math.round(cur.temperature)}°C (cảm giác như ${Math.round(cur.feelsLike)}°C) · ${cur.icon || ''} ${cur.text || ''}`,
    `💧 Độ ẩm: ${Math.round(cur.humidity)}% · 💨 Gió: ${cur.windSpeed.toFixed(1)} km/h`,
    '',
    `📊 Tổng quan trong ngày:`,
    `• 🌡 Nhiệt độ: ${Math.round(today.minTemp)}°C → ${Math.round(today.maxTemp)}°C (cảm giác ${Math.round(today.feelsMin)}°C → ${Math.round(today.feelsMax)}°C)`,
    `• ${today.icon || '🌤'} Thời tiết chung: ${today.text}`,
    `• 🌧 Khả năng mưa: ${Math.round(today.rainProbMax)}%${today.rainSum > 0 ? ` (lượng mưa ~${today.rainSum.toFixed(1)} mm)` : ''}`,
    `• ☀️ Chỉ số UV cực đại: ${describeUvIndex(today.uvMax)}`,
  ];

  if (today.sunrise || today.sunset) {
    lines.push(`• 🌅 Mặt trời mọc: ${today.sunrise || '--:--'} · 🌇 Lặn: ${today.sunset || '--:--'}`);
  }

  const periodLines = [];
  if (report.periods?.morning) {
    const p = report.periods.morning;
    periodLines.push(`• 🌅 Sáng (06h–11h): ${p.tempRange} · ${p.icon} ${p.text} (🌧 ${p.rainProb}%)`);
  }
  if (report.periods?.afternoon) {
    const p = report.periods.afternoon;
    periodLines.push(`• ☀️ Trưa–Chiều (12h–17h): ${p.tempRange} · ${p.icon} ${p.text} (🌧 ${p.rainProb}%)`);
  }
  if (report.periods?.evening) {
    const p = report.periods.evening;
    periodLines.push(`• 🌆 Tối (18h–23h): ${p.tempRange} · ${p.icon} ${p.text} (🌧 ${p.rainProb}%)`);
  }
  if (periodLines.length > 0) {
    lines.push('', '⏱ Diễn biến theo khung giờ:', ...periodLines);
  }

  if (report.tomorrow) {
    const tm = report.tomorrow;
    lines.push(
      '',
      `📅 Ngày mai (${tm.displayDate}): ${tm.minTemp}°C → ${tm.maxTemp}°C · ${tm.icon} ${tm.text} (🌧 ${tm.rainProbMax}%)`,
    );
  }

  if (Array.isArray(report.tips) && report.tips.length > 0) {
    lines.push('', '💡 Lưu ý hôm nay:', ...report.tips.map((tip) => `• ${tip}`));
  }

  return lines.join('\n');
}
