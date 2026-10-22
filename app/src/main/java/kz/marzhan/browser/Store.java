package kz.marzhan.browser;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Закладки, история и открытые вкладки — хранятся в настройках приложения. */
final class Store {
    private static final int MAX_HISTORY = 1000;

    private final SharedPreferences prefs;
    final JSONArray history;
    final JSONArray bookmarks;

    Store(Context context) {
        prefs = context.getSharedPreferences("mb", Context.MODE_PRIVATE);
        history = load("history");
        bookmarks = load("bookmarks");
    }

    private JSONArray load(String key) {
        try {
            return new JSONArray(prefs.getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    void save() {
        prefs.edit()
                .putString("history", history.toString())
                .putString("bookmarks", bookmarks.toString())
                .apply();
    }

    static JSONObject entry(String url, String title) {
        JSONObject o = new JSONObject();
        try {
            o.put("url", url);
            o.put("title", title == null || title.isEmpty() ? url : title);
            o.put("time", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        return o;
    }

    // ───── История ─────

    void addHistory(String url, String title) {
        int n = history.length();
        JSONObject last = n > 0 ? history.optJSONObject(n - 1) : null;
        if (last != null && url.equals(last.optString("url"))) {
            try {
                last.put("time", System.currentTimeMillis());
                if (title != null && !title.isEmpty()) last.put("title", title);
            } catch (JSONException ignored) {
            }
        } else {
            history.put(entry(url, title));
        }
        while (history.length() > MAX_HISTORY) history.remove(0);
    }

    void updateHistoryTitle(String url, String title) {
        int n = history.length();
        JSONObject last = n > 0 ? history.optJSONObject(n - 1) : null;
        if (last != null && url.equals(last.optString("url")) && title != null && !title.isEmpty()) {
            try {
                last.put("title", title);
            } catch (JSONException ignored) {
            }
        }
    }

    /** Последние уникальные адреса, сначала новые. */
    List<JSONObject> recentHistory(int limit) {
        List<JSONObject> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = history.length() - 1; i >= 0 && out.size() < limit; i--) {
            JSONObject h = history.optJSONObject(i);
            if (h == null || !seen.add(h.optString("url"))) continue;
            out.add(h);
        }
        return out;
    }

    void clearHistory() {
        while (history.length() > 0) history.remove(0);
        save();
    }

    /** Самые посещаемые сайты — для плиток начальной страницы. */
    JSONArray topSites() {
        Map<String, long[]> stats = new HashMap<>(); // host -> [count, lastTime]
        Map<String, String> origins = new HashMap<>();
        for (int i = 0; i < history.length(); i++) {
            JSONObject h = history.optJSONObject(i);
            if (h == null) continue;
            Uri u = Uri.parse(h.optString("url"));
            String scheme = u.getScheme();
            String host = u.getHost();
            if (host == null || !("http".equals(scheme) || "https".equals(scheme))) continue;
            long[] s = stats.get(host);
            if (s == null) {
                s = new long[]{0, 0};
                stats.put(host, s);
                origins.put(host, scheme + "://" + u.getEncodedAuthority() + "/");
            }
            s[0]++;
            s[1] = Math.max(s[1], h.optLong("time"));
        }
        List<Map.Entry<String, long[]>> list = new ArrayList<>(stats.entrySet());
        list.sort((a, b) -> a.getValue()[0] != b.getValue()[0]
                ? Long.compare(b.getValue()[0], a.getValue()[0])
                : Long.compare(b.getValue()[1], a.getValue()[1]));
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.size() && i < 12; i++) {
            String host = list.get(i).getKey();
            JSONObject o = new JSONObject();
            try {
                o.put("url", origins.get(host));
                o.put("title", host.startsWith("www.") ? host.substring(4) : host);
            } catch (JSONException ignored) {
            }
            out.put(o);
        }
        return out;
    }

    // ───── Закладки ─────

    int bookmarkIndex(String url) {
        for (int i = 0; i < bookmarks.length(); i++) {
            JSONObject b = bookmarks.optJSONObject(i);
            if (b != null && url.equals(b.optString("url"))) return i;
        }
        return -1;
    }

    /** @return true, если закладка добавлена, false — если удалена. */
    boolean toggleBookmark(String url, String title) {
        int i = bookmarkIndex(url);
        if (i >= 0) bookmarks.remove(i);
        else bookmarks.put(entry(url, title));
        save();
        return i < 0;
    }

    void removeBookmark(int index) {
        bookmarks.remove(index);
        save();
    }

    // ───── Вкладки и настройки ─────

    void saveSession(List<String> urls, int active) {
        prefs.edit()
                .putString("session", new JSONArray(urls).toString())
                .putInt("sessionActive", active)
                .apply();
    }

    List<String> loadSession() {
        List<String> out = new ArrayList<>();
        JSONArray a = load("session");
        for (int i = 0; i < a.length(); i++) {
            String u = a.optString(i, "");
            if (!u.isEmpty()) out.add(u);
        }
        return out;
    }

    int sessionActive() {
        return prefs.getInt("sessionActive", 0);
    }

    /** system | light | dark */
    static String theme(Context context) {
        return context.getSharedPreferences("mb", Context.MODE_PRIVATE).getString("theme", "system");
    }

    void setTheme(String theme) {
        prefs.edit().putString("theme", theme).commit(); // commit: сразу после этого окно пересоздаётся
    }

    boolean darkenSites() {
        return prefs.getBoolean("darkenSites", false);
    }

    void setDarkenSites(boolean on) {
        prefs.edit().putBoolean("darkenSites", on).apply();
    }

    boolean desktopMode() {
        return prefs.getBoolean("desktopMode", false);
    }

    void setDesktopMode(boolean on) {
        prefs.edit().putBoolean("desktopMode", on).apply();
    }
}
