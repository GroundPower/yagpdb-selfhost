package templates

// HTTP fetch fonksiyonları — self-host eklemesidir, upstream YAGPDB'de yoktur.
// `httpGet` ve `httpGetJSON` template fonksiyonlarını sağlar.
//
// Güvenlik:
//   - Allowlist (env: YAGPDB_HTTP_FETCH_HOSTS, virgülle ayrılmış host listesi).
//     Boşsa hiçbir host'a izin verilmez (deny by default).
//   - SSRF koruması: hostname DNS ile resolve edilir, private/loopback/link-local
//     IP aralıkları reddedilir (Docker iç network'üne erişim engellenir).
//   - http/https dışı şemalar reddedilir.
//   - 5 saniye timeout, 1 MB body limit, CC başına 10 çağrı limit.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	httpFetchTimeout      = 5 * time.Second
	httpFetchMaxBodyBytes = 1024 * 1024 // 1 MB
	httpFetchMaxCalls     = 10          // CC başına
	httpFetchUserAgent    = "YAGPDB-selfhost/1.0 (httpGet template fn)"
)

var (
	httpFetchAllowlistOnce sync.Once
	httpFetchAllowlistMap  map[string]struct{}

	httpFetchClient = &http.Client{
		Timeout: httpFetchTimeout,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   httpFetchTimeout,
				KeepAlive: 30 * time.Second,
				Control:   ssrfDialControl,
			}).DialContext,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   httpFetchTimeout,
			ResponseHeaderTimeout: httpFetchTimeout,
		},
	}
)

// loadHTTPAllowlist YAGPDB_HTTP_FETCH_HOSTS env'inden host setini bir kere yükler.
func loadHTTPAllowlist() map[string]struct{} {
	httpFetchAllowlistOnce.Do(func() {
		httpFetchAllowlistMap = map[string]struct{}{}
		raw := os.Getenv("YAGPDB_HTTP_FETCH_HOSTS")
		for _, h := range strings.Split(raw, ",") {
			h = strings.TrimSpace(strings.ToLower(h))
			if h != "" {
				httpFetchAllowlistMap[h] = struct{}{}
			}
		}
	})
	return httpFetchAllowlistMap
}

// hostAllowed parsed URL host'u allowlist'te mi kontrolü.
func hostAllowed(host string) bool {
	host = strings.ToLower(host)
	// port'u at
	if i := strings.LastIndex(host, ":"); i != -1 {
		host = host[:i]
	}
	_, ok := loadHTTPAllowlist()[host]
	return ok
}

// ssrfDialControl her dial'dan önce çözümlenmiş IP'nin private/loopback olmadığını
// doğrular. address burada zaten net dialer tarafından IP'ye resolve edilmiş haldedir,
// bu da DNS rebinding'i engeller (resolve + connect arasında IP değişemez).
func ssrfDialControl(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("httpGet: invalid resolved address: %s", host)
	}
	if isInternalIP(ip) {
		return fmt.Errorf("httpGet: refusing to connect to internal IP %s", ip)
	}
	return nil
}

func isInternalIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// 10.0.0.0/8
		if ip4[0] == 10 {
			return true
		}
		// 172.16.0.0/12
		if ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31 {
			return true
		}
		// 192.168.0.0/16
		if ip4[0] == 192 && ip4[1] == 168 {
			return true
		}
		// 100.64.0.0/10  (CGNAT)
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
		// 169.254.0.0/16  (link-local, AWS metadata 169.254.169.254 dahil)
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
	}
	if ip.To4() == nil {
		// IPv6 ULA fc00::/7
		if len(ip) == net.IPv6len && (ip[0]&0xfe) == 0xfc {
			return true
		}
	}
	return false
}

// validateAndPrepareURL şema, host ve allowlist kontrolü yapar.
func validateAndPrepareURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("httpGet: URL parse error: %v", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("httpGet: only http/https allowed, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("httpGet: missing host")
	}
	if !hostAllowed(u.Host) {
		return nil, fmt.Errorf("httpGet: host %q not in YAGPDB_HTTP_FETCH_HOSTS allowlist", u.Host)
	}
	return u, nil
}

// fetchHTTP HTTP GET yapar, body'yi (en fazla 1MB) ve status code'u döner.
func (c *Context) fetchHTTP(rawURL string) (string, int, error) {
	u, err := validateAndPrepareURL(rawURL)
	if err != nil {
		return "", 0, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), httpFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", 0, fmt.Errorf("httpGet: request build error: %v", err)
	}
	req.Header.Set("User-Agent", httpFetchUserAgent)
	req.Header.Set("Accept", "*/*")

	resp, err := httpFetchClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("httpGet: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, httpFetchMaxBodyBytes+1))
	if err != nil {
		return "", resp.StatusCode, fmt.Errorf("httpGet: read body: %v", err)
	}
	if int64(len(body)) > httpFetchMaxBodyBytes {
		return "", resp.StatusCode, fmt.Errorf("httpGet: response body exceeds %d bytes", httpFetchMaxBodyBytes)
	}
	return string(body), resp.StatusCode, nil
}

// tmplHTTPGet response body'yi string olarak döner. Status >= 400 ise hata.
func (c *Context) tmplHTTPGet(rawURL string) (string, error) {
	if c.IncreaseCheckCallCounter("http_get", httpFetchMaxCalls) {
		return "", ErrTooManyCalls
	}
	body, status, err := c.fetchHTTP(rawURL)
	if err != nil {
		return "", err
	}
	if status >= 400 {
		return "", fmt.Errorf("httpGet: HTTP %d", status)
	}
	if len(body) > MaxStringLength {
		return "", ErrStringTooLong
	}
	return body, nil
}

// tmplHTTPGetJSON response body'yi JSON olarak parse edip sdict / slice döner.
func (c *Context) tmplHTTPGetJSON(rawURL string) (interface{}, error) {
	if c.IncreaseCheckCallCounter("http_get", httpFetchMaxCalls) {
		return nil, ErrTooManyCalls
	}
	body, status, err := c.fetchHTTP(rawURL)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, fmt.Errorf("httpGetJSON: HTTP %d", status)
	}

	var parsed interface{}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return nil, fmt.Errorf("httpGetJSON: invalid JSON: %v", err)
	}
	return convertJSONToSDict(parsed), nil
}

// convertJSONToSDict map[string]interface{} -> SDict, []interface{} -> Slice dönüşümü
// yapar ki template'de .Foo veya `index $x 0` gibi YAGPDB idiomatik erişim çalışsın.
func convertJSONToSDict(v interface{}) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		out := SDict{}
		for k, vv := range val {
			out[k] = convertJSONToSDict(vv)
		}
		return out
	case []interface{}:
		out := make(Slice, len(val))
		for i, vv := range val {
			out[i] = convertJSONToSDict(vv)
		}
		return out
	default:
		return v
	}
}
