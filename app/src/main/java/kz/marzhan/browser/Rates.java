package kz.marzhan.browser;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Курсы валют для начальной страницы: Нацбанк РК, запасной вариант — open.er-api.com. */
final class Rates {
    interface Callback {
        void done(String json); // null, если загрузить не удалось
    }

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final long TTL = 60 * 60 * 1000L;
    private static String cache;
    private static long cacheTime;

    private Rates() {
    }

    static void fetch(Callback cb) {
        synchronized (Rates.class) {
            if (cache != null && System.currentTimeMillis() - cacheTime < TTL) {
                cb.done(cache);
                return;
            }
        }
        EXEC.execute(() -> {
            String result = null;
            try {
                result = nationalBank();
            } catch (Exception ignored) {
            }
            if (result == null) {
                try {
                    result = openApi();
                } catch (Exception ignored) {
                }
            }
            if (result != null) {
                synchronized (Rates.class) {
                    cache = result;
                    cacheTime = System.currentTimeMillis();
                }
            }
            cb.done(result);
        });
    }

    private static String get(String address) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) MiniBrowser");
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    private static String tag(String s, String name) {
        Matcher m = Pattern.compile("<" + name + ">([^<]*)</" + name + ">").matcher(s);
        return m.find() ? m.group(1).trim() : null;
    }

    private static double num(String s) {
        if (s == null) return Double.NaN;
        try {
            return Double.parseDouble(s.replace(',', '.').replace("+", ""));
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static String nationalBank() throws IOException, JSONException {
        String xml = get("https://nationalbank.kz/rss/rates_all.xml");
        JSONObject rates = new JSONObject();
        Matcher items = Pattern.compile("<item>([\\s\\S]*?)</item>").matcher(xml);
        String date = null;
        while (items.find()) {
            String item = items.group(1);
            String code = tag(item, "title");
            double value = num(tag(item, "description"));
            double quant = num(tag(item, "quant"));
            double change = num(tag(item, "change"));
            if (Double.isNaN(quant) || quant == 0) quant = 1;
            if (code == null || Double.isNaN(value)) continue;
            JSONObject r = new JSONObject();
            r.put("value", value / quant);
            r.put("change", Double.isNaN(change) ? JSONObject.NULL : change / quant);
            rates.put(code, r);
            if (date == null) date = tag(item, "pubDate");
        }
        if (!rates.has("USD")) return null;
        JSONObject out = new JSONObject();
        out.put("source", "Нацбанк РК" + (date != null ? ", " + date : ""));
        out.put("rates", rates);
        return out.toString();
    }

    private static String openApi() throws IOException, JSONException {
        JSONObject json = new JSONObject(get("https://open.er-api.com/v6/latest/KZT"));
        JSONObject src = json.optJSONObject("rates");
        if (src == null) return null;
        JSONObject rates = new JSONObject();
        for (String code : new String[]{"USD", "EUR", "RUB", "CNY"}) {
            double v = src.optDouble(code, Double.NaN);
            if (Double.isNaN(v) || v == 0) continue;
            JSONObject r = new JSONObject();
            r.put("value", 1 / v);
            r.put("change", JSONObject.NULL);
            rates.put(code, r);
        }
        if (!rates.has("USD")) return null;
        JSONObject out = new JSONObject();
        out.put("source", "рыночный курс");
        out.put("rates", rates);
        return out.toString();
    }
}
