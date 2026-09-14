"""局域网验收：只读取真实画面；可选验证一个空通道的设置保存。"""
import argparse
import concurrent.futures
import copy
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', default='smoke-result.json')
    parser.add_argument('--exercise-settings', action='store_true')
    args = parser.parse_args()
    base = args.url.rstrip('/')

    def request(path, method='GET', body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers=headers or {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def api(path):
        code, _, data = request(path)
        assert code == 200, (path, code, data[:200])
        return json.loads(data)

    status = api('/api/status')
    assert len(status['channels']) == 5
    assert status['channels'][0]['state'] == 'online'
    assert status['channels'][0]['recording']
    assert status['detector']['ready'] and status['detector']['inferences'] > 0
    config = api('/api/config')
    invalid = copy.deepcopy(config)
    invalid['channels'][0]['recording']['segment_minutes'] = 2
    assert request('/api/config', 'PUT', invalid)[0] == 400
    assert api('/api/config') == config
    if args.exercise_settings:
        assert status['channels'][4]['state'] == 'no_signal', '只允许临时关闭空通道'
        temporary = copy.deepcopy(config)
        temporary['channels'][4]['enabled'] = False
        try:
            assert request('/api/config', 'PUT', temporary)[0] == 200
            assert api('/api/status')['channels'][4]['state'] == 'disabled'
            assert request('/api/snapshot/5.jpg')[0] == 503
        finally:
            assert request('/api/config', 'PUT', config)[0] == 200

    assert request('/api/snapshot/1.jpg')[2][:2] == b'\xff\xd8'
    for channel in status['channels'][1:]:
        if channel['state'] == 'no_signal':
            assert request(f"/stream/{channel['id']}.mjpg")[0] == 503
    for event_type in ('person', 'vehicle', 'animal', 'dwell'):
        events = api('/api/events?event_type=' + event_type)['items']
        assert all(event['event_type'] == event_type for event in events)

    recordings = api('/api/recordings?channel_id=1')['items']
    assert recordings, '需等待第一个片段封装完成'
    recording = recordings[0]
    url = recording['url']
    code, headers, body = request(url, headers={'Range': 'bytes=0-4095'})
    assert code == 206 and len(body) == 4096 and headers['Content-Range'].startswith('bytes 0-4095/')
    assert request(url, headers={'Range': 'bytes=-512'})[0] == 206
    assert request(url, headers={'Range': 'bytes=999999999999-'})[0] == 416
    assert request(url, 'HEAD')[1]['Content-Length'] == str(recording['size_bytes'])
    assert request('/media/not-found')[0] == 404
    start = datetime.fromisoformat(recording['created_at'].replace('Z', '+00:00'))
    # 查询从片段中间开始的窗口，验证跨边界的片段不会遗漏。
    query = urllib.parse.urlencode({'channel_id': 1, 'start': (start + timedelta(seconds=1)).isoformat(),
                                   'end': (start + timedelta(seconds=120)).isoformat()})
    timeline = api('/api/timeline?' + query)
    assert recording['id'] in {row['id'] for row in timeline['recordings']}
    assert request('/api/timeline?channel_id=1&start=bad&end=bad')[0] == 400
    code, _, logs = request('/api/logs/download')
    assert code == 200
    with zipfile.ZipFile(io.BytesIO(logs)) as bundle:
        assert {'status.json', 'model.json', 'host.log'} <= set(bundle.namelist())
        assert all(not name.endswith(('.jpg', '.mp4', '.rknn')) for name in bundle.namelist())

    def stream():
        with urllib.request.urlopen(base + '/stream/1.mjpg', timeout=10) as response:
            began, frames = time.monotonic(), 0
            while time.monotonic() - began < 6:
                assert response.readline().strip() == b'--frame'
                fields = {}
                while True:
                    line = response.readline().strip()
                    if not line:
                        break
                    key, value = line.split(b':', 1)
                    fields[key.lower()] = value.strip()
                count = int(fields[b'content-length'])
                data = response.read(count)
                assert len(data) == count and data[:2] == b'\xff\xd8'
                assert response.read(2) == b'\r\n'
                frames += 1
            return round(frames / (time.monotonic() - began), 2)

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        streams = [pool.submit(stream) for _ in range(6)]
        began = time.monotonic()
        api('/api/status')
        latency = time.monotonic() - began
        rates = [future.result() for future in streams]
    result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'status': api('/api/status'),
              'six_stream_fps': rates, 'status_latency_seconds': latency,
              'recording': recording, 'checks': 'config, events, timeline, range, logs, concurrent MJPEG: PASS'}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'checks': result['checks'], 'six_stream_fps': rates,
                      'status_latency_seconds': round(latency, 3)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
