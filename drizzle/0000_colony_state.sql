CREATE TABLE "colony_state" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"phase" text NOT NULL,
	"epoch" integer NOT NULL,
	"paused" boolean NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
