// Package llm wraps the OpenAI SDK behind one reusable, service-agnostic client.
//
// Construct it once per process with New and share the *Client across goroutines
// (the underlying openai.Client is safe for concurrent use). Any service — api,
// intel, replay — depends only on this package and config, never on the SDK
// directly, so swapping models or the base URL (Azure, a gateway) is a config
// change rather than a code change.
//
// The client is optional by design: when OPENAI_API_KEY is unset, New returns
// ErrNoAPIKey and callers fall back to their rule-based path (see intel).
package llm

import (
	"context"
	"errors"
	"net/http"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
	"github.com/openai/openai-go/v3/shared"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// DefaultModel is used when config.OpenAIModel is empty.
const DefaultModel = openai.ChatModelGPT5_2

// ErrNoAPIKey is returned by New when no API key is configured. Callers treat
// this as "LLM disabled" and fall back, rather than failing the process.
var ErrNoAPIKey = errors.New("llm: OPENAI_API_KEY not set")

// Client is a thin, reusable handle over the OpenAI SDK.
type Client struct {
	api   openai.Client
	model string
}

// New builds a Client from configuration. Returns ErrNoAPIKey if the key is
// unset so callers can degrade gracefully instead of crashing.
func New(cfg config.Config) (*Client, error) {
	if cfg.OpenAIAPIKey == "" {
		return nil, ErrNoAPIKey
	}
	opts := []option.RequestOption{
		option.WithAPIKey(cfg.OpenAIAPIKey),
		// Trace the outbound call like every other dependency (trace↔log links in Grafana).
		option.WithHTTPClient(&http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}),
	}
	if cfg.OpenAIBaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.OpenAIBaseURL))
	}
	model := cfg.OpenAIModel
	if model == "" {
		model = DefaultModel
	}
	return &Client{api: openai.NewClient(opts...), model: model}, nil
}

// Model reports the model this client sends requests with.
func (c *Client) Model() string { return c.model }

// Raw exposes the underlying SDK client for calls this wrapper does not cover
// (streaming, tools, images, embeddings). Prefer adding a method here when a
// call is used in more than one place.
func (c *Client) Raw() openai.Client { return c.api }

// Complete sends a single prompt to the Responses API and returns the text.
// The provided context bounds all retries; pass one with a timeout.
func (c *Client) Complete(ctx context.Context, prompt string) (string, error) {
	return c.CompleteWith(ctx, "", prompt)
}

// CompleteWith is Complete with a system-style instruction. An empty
// instruction behaves exactly like Complete.
func (c *Client) CompleteWith(ctx context.Context, instructions, prompt string) (string, error) {
	params := responses.ResponseNewParams{
		Model: c.model,
		Input: responses.ResponseNewParamsInputUnion{OfString: openai.String(prompt)},
	}
	if instructions != "" {
		params.Instructions = openai.String(instructions)
	}
	resp, err := c.api.Responses.New(ctx, params)
	if err != nil {
		return "", err
	}
	return resp.OutputText(), nil
}

// DefaultMaxOutputTokens caps a single response as a runaway/cost guard. It is
// deliberately generous: reasoning models spend part of this budget on hidden
// reasoning tokens, so a tight cap can starve the visible answer to empty.
const DefaultMaxOutputTokens int64 = 2048

// JSONRequest asks the model for output conforming to a JSON schema, using
// OpenAI Structured Outputs (strict mode). The returned string is guaranteed
// to be valid JSON for Schema, so callers can json.Unmarshal it directly.
type JSONRequest struct {
	Instructions string         // system-style guidance; may be empty
	Prompt       string         // the user input / data
	SchemaName   string         // schema identifier sent to the API (required)
	Schema       map[string]any // JSON Schema, Structured Outputs subset (required)
	MaxTokens    int64          // 0 => DefaultMaxOutputTokens
	// Effort bounds reasoning on reasoning models: "minimal" | "low" | "medium" |
	// "high" (and none/xhigh/max). Lower effort is faster and cheaper; "" leaves
	// the model default. For short, well-scoped structured tasks, "low" is a good
	// latency/quality trade-off.
	Effort string
}

// CompleteJSON runs a strict structured-output request. The provided context
// bounds all retries; pass one with a timeout.
func (c *Client) CompleteJSON(ctx context.Context, req JSONRequest) (string, error) {
	maxTok := req.MaxTokens
	if maxTok <= 0 {
		maxTok = DefaultMaxOutputTokens
	}
	params := responses.ResponseNewParams{
		Model:           c.model,
		Input:           responses.ResponseNewParamsInputUnion{OfString: openai.String(req.Prompt)},
		MaxOutputTokens: openai.Int(maxTok),
		Text: responses.ResponseTextConfigParam{
			Format: responses.ResponseFormatTextConfigUnionParam{
				OfJSONSchema: &responses.ResponseFormatTextJSONSchemaConfigParam{
					Name:   req.SchemaName,
					Schema: req.Schema,
					Strict: openai.Bool(true),
				},
			},
		},
	}
	if req.Instructions != "" {
		params.Instructions = openai.String(req.Instructions)
	}
	if req.Effort != "" {
		params.Reasoning = shared.ReasoningParam{Effort: shared.ReasoningEffort(req.Effort)}
	}
	resp, err := c.api.Responses.New(ctx, params)
	if err != nil {
		return "", err
	}
	return resp.OutputText(), nil
}
