package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDocsEndpoints(t *testing.T) {
	mux := http.NewServeMux()
	registerDocs(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cases := []struct {
		path        string
		contentType string
		contains    string
	}{
		{"/openapi.yaml", "application/yaml", "FuelOps Operator API"},
		{"/docs", "text/html", "swagger-ui"},
		{"/redoc", "text/html", "redoc"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			resp, err := http.Get(srv.URL + c.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d", resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, c.contentType) {
				t.Errorf("content-type %q, want contains %q", ct, c.contentType)
			}
			body, _ := io.ReadAll(resp.Body)
			if !strings.Contains(string(body), c.contains) {
				t.Errorf("body missing %q", c.contains)
			}
		})
	}
}

// TestOpenAPISpecDocumentsEveryRoute asserts the embedded spec is OpenAPI 3.x and
// declares every endpoint this service actually serves, so the docs never drift
// silently from the handlers.
func TestOpenAPISpecDocumentsEveryRoute(t *testing.T) {
	spec := string(openapiSpec)
	if !strings.Contains(spec, "openapi: 3.") {
		t.Fatalf("embedded spec is not OpenAPI 3.x")
	}
	want := []string{"/healthz:", "/version:", "/metrics:"}
	for _, p := range (&server{hub: newHub()}).routes(http.NewServeMux()) {
		_, path, _ := strings.Cut(p, " ")
		want = append(want, "  "+path+":")
	}
	for _, want := range want {
		if !strings.Contains(spec, want) {
			t.Errorf("spec is missing documented path %q", want)
		}
	}
}
