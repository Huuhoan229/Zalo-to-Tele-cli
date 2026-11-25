import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WEATHER_LOCATION,
  fetchWeatherForecast,
  formatWeatherReport,
  resolveWeatherLocation,
} from '../src/weather.js';

test('resolveWeatherLocation defaults to Hanoi and matches preset aliases and geocoding', async () => {
  const def = await resolveWeatherLocation('');
  assert.equal(def.name, DEFAULT_WEATHER_LOCATION.name);
  assert.equal(def.latitude, DEFAULT_WEATHER_LOCATION.latitude);

  const hn = await resolveWeatherLocation('hn');
  assert.equal(hn.name, 'Hà Nội');

  const duongNoi = await resolveWeatherLocation('Dương Nội');
  assert.equal(duongNoi.name, 'Dương Nội, Hà Đông, Hà Nội');

  const custom = await resolveWeatherLocation('Đà Lạt', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            name: 'Đà Lạt',
            admin1: 'Lâm Đồng',
            country_code: 'VN',
            latitude: 11.9465,
            longitude: 108.4419,
          },
        ],
      }),
    }),
  });
  assert.equal(custom.name, 'Đà Lạt, Lâm Đồng');
  assert.equal(custom.latitude, 11.9465);
  assert.equal(custom.longitude, 108.4419);
});

test('fetchWeatherForecast and formatWeatherReport produce a clear Vietnamese daily forecast', async () => {
  const mockApi = {
    current: {
      temperature_2m: 21.4,
      apparent_temperature: 20.8,
      relative_humidity_2m: 74,
      weather_code: 1,
      wind_speed_10m: 11.2,
    },
    daily: {
      time: ['2026-11-25', '2026-11-26'],
      weather_code: [2, 61],
      temperature_2m_min: [18.2, 17.0],
      temperature_2m_max: [26.8, 23.4],
      apparent_temperature_min: [17.5, 16.2],
      apparent_temperature_max: [27.1, 22.9],
      sunrise: ['2026-11-25T06:12', '2026-11-26T06:13'],
      sunset: ['2026-11-25T17:16', '2026-11-26T17:16'],
      uv_index_max: [6.4, 4.2],
      precipitation_sum: [0.0, 4.5],
      precipitation_probability_max: [20, 75],
    },
    hourly: {
      time: [
        '2026-11-25T06:00',
        '2026-11-25T09:00',
        '2026-11-25T13:00',
        '2026-11-25T16:00',
        '2026-11-25T19:00',
        '2026-11-25T22:00',
      ],
      temperature_2m: [19, 22, 26, 25, 22, 20],
      apparent_temperature: [18, 22, 27, 25, 22, 19],
      precipitation_probability: [10, 15, 20, 15, 10, 5],
      weather_code: [1, 1, 2, 2, 1, 0],
    },
  };

  const report = await fetchWeatherForecast({
    locationName: 'Hà Nội',
    now: new Date('2026-11-25T06:00:00+07:00'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => mockApi,
    }),
  });

  assert.equal(report.locationName, 'Hà Nội');
  assert.equal(report.displayDate, '25/11/2026');
  const formatted = formatWeatherReport(report);
  assert.match(formatted, /DỰ BÁO THỜI TIẾT HÔM NAY \(25\/11\/2026\)/);
  assert.match(formatted, /📍 Địa điểm: Hà Nội/);
  assert.match(formatted, /18°C → 27°C/);
  assert.match(formatted, /Sáng \(06h–11h\)/);
  assert.match(formatted, /Trưa–Chiều \(12h–17h\)/);
  assert.match(formatted, /Tối \(18h–23h\)/);
  assert.match(formatted, /Ngày mai \(26\/11\/2026\)/);
});
