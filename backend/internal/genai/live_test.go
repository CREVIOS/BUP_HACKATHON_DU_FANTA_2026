package genai_test

import (
	"bufio"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/genai"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/llm"
)

// TestLiveExplain calls the real OpenAI Responses API end to end through the
// llm client and the explainer. It is skipped unless OPENAI_API_KEY is set
// (directly in the environment or in a .env file at the backend or repo root),
// so the default `go test ./...` never makes a network call.
//
//	Run it explicitly:  go test ./internal/genai/ -run TestLiveExplain -v
func TestLiveExplain(t *testing.T) {
	loadDotenv(t, ".env", "../../.env", "../../../.env")
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		t.Skip("OPENAI_API_KEY not set (put it in .env or the environment); skipping live OpenAI test")
	}

	cfg := config.Config{
		OpenAIAPIKey:  key,
		OpenAIModel:   os.Getenv("OPENAI_MODEL"),
		OpenAIBaseURL: os.Getenv("OPENAI_BASE_URL"),
	}
	client, err := llm.New(cfg)
	if err != nil {
		t.Fatalf("llm.New: %v", err)
	}
	t.Logf("model: %s", client.Model())

	in := genai.DecisionInput{
		StationID: "STN-MIRPUR", FuelType: "diesel", DepotID: "DEP-GAZIPUR", RouteID: "R-1",
		Quantity: 5000, RiskBefore: 0.72, RiskAfter: 0.05, TimeToStockout: 18, Verdict: "auto",
		BindingConstraint: "route max",
		Signals:           map[string]any{"on_hand": 8400.0, "reorder_point": 11000.0, "demand_next_horizon": 11900.0},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	ex := genai.NewExplainer(client).Explain(ctx, in)

	t.Logf("headline:   %s", ex.Headline)
	t.Logf("narrative:  %s", ex.Narrative)
	t.Logf("factors:    %v", ex.Factors)
	t.Logf("confidence: %s   action: %s   source: %s", ex.Confidence, ex.Action, ex.Source)

	if ex.Source != "llm" {
		t.Fatalf("expected a live LLM answer, got source=%q (the call fell back — check the key/model)", ex.Source)
	}
	if strings.TrimSpace(ex.Narrative) == "" {
		t.Fatalf("live narrative is empty")
	}
	if len(ex.Factors) == 0 {
		t.Fatalf("live factors are empty")
	}
	// Deterministic guarantees hold on the live path too.
	if ex.Confidence != "high" {
		t.Fatalf("confidence = %q, want high (risk_after 0.05)", ex.Confidence)
	}
	if !strings.Contains(ex.Headline, "72%→5%") {
		t.Fatalf("headline numbers wrong: %q", ex.Headline)
	}
}

// TestLiveComplete is a minimal smoke test of the raw client's text path.
func TestLiveComplete(t *testing.T) {
	loadDotenv(t, ".env", "../../.env", "../../../.env")
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		t.Skip("OPENAI_API_KEY not set; skipping live OpenAI test")
	}
	client, err := llm.New(config.Config{OpenAIAPIKey: key, OpenAIModel: os.Getenv("OPENAI_MODEL"), OpenAIBaseURL: os.Getenv("OPENAI_BASE_URL")})
	if err != nil {
		t.Fatalf("llm.New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := client.Complete(ctx, "Reply with exactly the word: OK")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	t.Logf("reply: %q", out)
	if strings.TrimSpace(out) == "" {
		t.Fatalf("empty reply from live API")
	}
}

// loadDotenv reads the first existing file from paths and sets any KEY=VALUE
// that is not already in the environment. Minimal parser: ignores blank lines
// and #comments, strips one layer of surrounding quotes, honors `export KEY=`.
func loadDotenv(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimPrefix(line, "export ")
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
			if _, exists := os.LookupEnv(k); !exists {
				os.Setenv(k, v)
			}
		}
		t.Logf("loaded env from %s", p)
		return
	}
}
