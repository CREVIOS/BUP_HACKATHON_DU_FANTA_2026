package api

import (
	_ "embed"
	"net/http"
)

// openapiSpec is the hand-maintained OpenAPI 3.0 description of this service,
// served at /openapi.yaml and rendered by Swagger UI (/docs) and ReDoc (/redoc)
// — the same convention the simulator exposes (guide §3).
//
//go:embed openapi.yaml
var openapiSpec []byte

const swaggerHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FuelOps Operator API — Swagger UI</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "openapi.yaml", dom_id: "#swagger-ui", deepLinking: true });
  </script>
</body>
</html>`

const redocHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FuelOps Operator API — ReDoc</title>
</head>
<body>
  <redoc spec-url="openapi.yaml"></redoc>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/redoc/2.1.5/redoc.standalone.js" crossorigin></script>
</body>
</html>`

// registerDocs wires the OpenAPI spec and the two documentation UIs onto mux.
func registerDocs(mux *http.ServeMux) {
	mux.HandleFunc("GET /openapi.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		w.Write(openapiSpec)
	})
	mux.HandleFunc("GET /docs", serveHTML(swaggerHTML))
	mux.HandleFunc("GET /redoc", serveHTML(redocHTML))
}

func serveHTML(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(body))
	}
}
