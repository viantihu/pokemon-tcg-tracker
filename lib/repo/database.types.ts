/**
 * Supabase schema types for the `public` schema (migrations 0001 + 0002 + 0004 + 0005).
 *
 * HAND-AUTHORED to mirror `supabase gen types typescript --local`. Regenerate from the live local
 * schema once the database is reachable and commit the result verbatim:
 *
 *   supabase gen types typescript --local > lib/repo/database.types.ts
 *
 * The repo layer (lib/repo/*) keys only on table and column names, so regenerating is a fidelity
 * check, not a rewrite. Keep this in sync with supabase/migrations/*.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      color_band: {
        Row: { band: string; display_name: string; position: number };
        Insert: { band: string; display_name: string; position: number };
        Update: { band?: string; display_name?: string; position?: number };
        Relationships: [];
      };
      type_color_map: {
        Row: { card_type: string; band: string };
        Insert: { card_type: string; band: string };
        Update: { card_type?: string; band?: string };
        Relationships: [
          {
            foreignKeyName: "type_color_map_band_fkey";
            columns: ["band"];
            referencedRelation: "color_band";
            referencedColumns: ["band"];
          },
        ];
      };
      catalog_card: {
        Row: {
          tcgdex_id: string;
          name: string;
          dex_id: number[];
          set_id: string | null;
          set_name: string | null;
          set_series: string | null;
          local_id: string | null;
          rarity: string | null;
          types: string[];
          stage: string | null;
          evolve_from: string | null;
          illustrator: string | null;
          hp: number | null;
          variants: Json;
          artwork_group_id: string | null;
          artwork_hash: string | null;
          artwork_group_locked: boolean;
          card_class: string;
          is_digital_only: boolean;
          image_url: string | null;
          price_low: number | null;
          price_market: number | null;
        };
        Insert: {
          tcgdex_id: string;
          name: string;
          dex_id?: number[];
          set_id?: string | null;
          set_name?: string | null;
          set_series?: string | null;
          local_id?: string | null;
          rarity?: string | null;
          types?: string[];
          stage?: string | null;
          evolve_from?: string | null;
          illustrator?: string | null;
          hp?: number | null;
          variants?: Json;
          artwork_group_id?: string | null;
          artwork_hash?: string | null;
          artwork_group_locked?: boolean;
          card_class?: string;
          is_digital_only?: boolean;
          image_url?: string | null;
          price_low?: number | null;
          price_market?: number | null;
        };
        Update: {
          tcgdex_id?: string;
          name?: string;
          dex_id?: number[];
          set_id?: string | null;
          set_name?: string | null;
          set_series?: string | null;
          local_id?: string | null;
          rarity?: string | null;
          types?: string[];
          stage?: string | null;
          evolve_from?: string | null;
          illustrator?: string | null;
          hp?: number | null;
          variants?: Json;
          artwork_group_id?: string | null;
          artwork_hash?: string | null;
          artwork_group_locked?: boolean;
          card_class?: string;
          is_digital_only?: boolean;
          image_url?: string | null;
          price_low?: number | null;
          price_market?: number | null;
        };
        Relationships: [];
      };
      haul: {
        Row: {
          id: string;
          owner_id: string;
          date: string;
          source: string;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          date?: string;
          source: string;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          date?: string;
          source?: string;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      binder: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          type: string;
          pages: number;
          pockets_per_page: number;
          back_half_start_page: number | null;
          is_active: boolean;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          name: string;
          type: string;
          pages?: number;
          pockets_per_page?: number;
          back_half_start_page?: number | null;
          is_active?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          type?: string;
          pages?: number;
          pockets_per_page?: number;
          back_half_start_page?: number | null;
          is_active?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      collection: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          definition_type: string;
          current_binder_ids: string[];
          target_catalog_card_ids: string[];
          status: string;
          mode: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          name: string;
          definition_type?: string;
          current_binder_ids?: string[];
          target_catalog_card_ids?: string[];
          status?: string;
          mode?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          definition_type?: string;
          current_binder_ids?: string[];
          target_catalog_card_ids?: string[];
          status?: string;
          mode?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      evolution_line: {
        Row: {
          id: string;
          owner_id: string;
          root_dex_id: number;
          color_band: string;
          binder_id: string | null;
          half: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          root_dex_id: number;
          color_band: string;
          binder_id?: string | null;
          half?: string;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          root_dex_id?: number;
          color_band?: string;
          binder_id?: string | null;
          half?: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "evolution_line_color_band_fkey";
            columns: ["color_band"];
            referencedRelation: "color_band";
            referencedColumns: ["band"];
          },
          {
            foreignKeyName: "evolution_line_binder_id_fkey";
            columns: ["binder_id"];
            referencedRelation: "binder";
            referencedColumns: ["id"];
          },
        ];
      };
      presence_group: {
        Row: {
          id: string;
          owner_id: string;
          catalog_card_id: string;
          dex_variant_raw: string;
          desired_count: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          catalog_card_id: string;
          dex_variant_raw: string;
          desired_count?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          catalog_card_id?: string;
          dex_variant_raw?: string;
          desired_count?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "presence_group_catalog_card_id_fkey";
            columns: ["catalog_card_id"];
            referencedRelation: "catalog_card";
            referencedColumns: ["tcgdex_id"];
          },
        ];
      };
      copy: {
        Row: {
          id: string;
          owner_id: string;
          catalog_card_id: string;
          variant: string;
          dex_variant_raw: string | null;
          presence_group_id: string | null;
          haul_id: string | null;
          acquired_at: string | null;
          role: string;
          binder_id: string | null;
          binder_half: string | null;
          color_band: string | null;
          line_slot_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          catalog_card_id: string;
          variant?: string;
          dex_variant_raw?: string | null;
          presence_group_id?: string | null;
          haul_id?: string | null;
          acquired_at?: string | null;
          role?: string;
          binder_id?: string | null;
          binder_half?: string | null;
          color_band?: string | null;
          line_slot_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          catalog_card_id?: string;
          variant?: string;
          dex_variant_raw?: string | null;
          presence_group_id?: string | null;
          haul_id?: string | null;
          acquired_at?: string | null;
          role?: string;
          binder_id?: string | null;
          binder_half?: string | null;
          color_band?: string | null;
          line_slot_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "copy_catalog_card_id_fkey";
            columns: ["catalog_card_id"];
            referencedRelation: "catalog_card";
            referencedColumns: ["tcgdex_id"];
          },
          {
            foreignKeyName: "copy_presence_group_id_fkey";
            columns: ["presence_group_id"];
            referencedRelation: "presence_group";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "copy_haul_id_fkey";
            columns: ["haul_id"];
            referencedRelation: "haul";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "copy_binder_id_fkey";
            columns: ["binder_id"];
            referencedRelation: "binder";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "copy_color_band_fkey";
            columns: ["color_band"];
            referencedRelation: "color_band";
            referencedColumns: ["band"];
          },
          {
            foreignKeyName: "copy_line_slot_fk";
            columns: ["line_slot_id"];
            referencedRelation: "line_slot";
            referencedColumns: ["id"];
          },
        ];
      };
      line_slot: {
        Row: {
          id: string;
          owner_id: string;
          line_id: string;
          stage_index: number;
          stage: string;
          state: string;
          copy_id: string | null;
          target_catalog_card_id: string | null;
          note: string | null;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          line_id: string;
          stage_index: number;
          stage: string;
          state: string;
          copy_id?: string | null;
          target_catalog_card_id?: string | null;
          note?: string | null;
        };
        Update: {
          id?: string;
          owner_id?: string;
          line_id?: string;
          stage_index?: number;
          stage?: string;
          state?: string;
          copy_id?: string | null;
          target_catalog_card_id?: string | null;
          note?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "line_slot_line_id_fkey";
            columns: ["line_id"];
            referencedRelation: "evolution_line";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "line_slot_copy_id_fkey";
            columns: ["copy_id"];
            referencedRelation: "copy";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "line_slot_target_catalog_card_id_fkey";
            columns: ["target_catalog_card_id"];
            referencedRelation: "catalog_card";
            referencedColumns: ["tcgdex_id"];
          },
        ];
      };
      wishlist_item: {
        Row: {
          id: string;
          owner_id: string;
          line_slot_id: string | null;
          required_dex_id: number | null;
          required_type: string | null;
          required_stage: string | null;
          chosen_catalog_card_id: string | null;
          alternate_catalog_card_ids: string[];
          held_for_binder_id: string | null;
          will_live_in_specialty: boolean;
          created_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          line_slot_id?: string | null;
          required_dex_id?: number | null;
          required_type?: string | null;
          required_stage?: string | null;
          chosen_catalog_card_id?: string | null;
          alternate_catalog_card_ids?: string[];
          held_for_binder_id?: string | null;
          will_live_in_specialty?: boolean;
          created_at?: string;
          resolved_at?: string | null;
        };
        Update: {
          id?: string;
          owner_id?: string;
          line_slot_id?: string | null;
          required_dex_id?: number | null;
          required_type?: string | null;
          required_stage?: string | null;
          chosen_catalog_card_id?: string | null;
          alternate_catalog_card_ids?: string[];
          held_for_binder_id?: string | null;
          will_live_in_specialty?: boolean;
          created_at?: string;
          resolved_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "wishlist_item_line_slot_id_fkey";
            columns: ["line_slot_id"];
            referencedRelation: "line_slot";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "wishlist_item_chosen_catalog_card_id_fkey";
            columns: ["chosen_catalog_card_id"];
            referencedRelation: "catalog_card";
            referencedColumns: ["tcgdex_id"];
          },
          {
            foreignKeyName: "wishlist_item_held_for_binder_id_fkey";
            columns: ["held_for_binder_id"];
            referencedRelation: "binder";
            referencedColumns: ["id"];
          },
        ];
      };
      binder_block: {
        Row: {
          id: string;
          owner_id: string;
          binder_id: string;
          half: string;
          pocket_count: number;
          purpose: string;
          material: string;
          copy_id: string | null;
          line_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          binder_id: string;
          half: string;
          pocket_count?: number;
          purpose: string;
          material: string;
          copy_id?: string | null;
          line_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          binder_id?: string;
          half?: string;
          pocket_count?: number;
          purpose?: string;
          material?: string;
          copy_id?: string | null;
          line_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "binder_block_binder_id_fkey";
            columns: ["binder_id"];
            referencedRelation: "binder";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "binder_block_copy_id_fkey";
            columns: ["copy_id"];
            referencedRelation: "copy";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "binder_block_line_id_fkey";
            columns: ["line_id"];
            referencedRelation: "evolution_line";
            referencedColumns: ["id"];
          },
        ];
      };
      placement_decision: {
        Row: {
          id: string;
          owner_id: string;
          haul_id: string | null;
          copy_id: string | null;
          decision: string;
          reason: string;
          resolved_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          haul_id?: string | null;
          copy_id?: string | null;
          decision: string;
          reason: string;
          resolved_by: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          haul_id?: string | null;
          copy_id?: string | null;
          decision?: string;
          reason?: string;
          resolved_by?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "placement_decision_haul_id_fkey";
            columns: ["haul_id"];
            referencedRelation: "haul";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "placement_decision_copy_id_fkey";
            columns: ["copy_id"];
            referencedRelation: "copy";
            referencedColumns: ["id"];
          },
        ];
      };
      unresolved_entry: {
        Row: {
          id: string;
          owner_id: string;
          dex_id: string;
          dex_set_name: string | null;
          dex_series: string | null;
          dex_number: string | null;
          dex_name: string | null;
          dex_variant_raw: string;
          quantity: number;
          locale: string | null;
          reason: string;
          status: string;
          first_seen_sync: string;
          last_retry_sync: string | null;
          retry_count: number;
          manual_match_id: string | null;
        };
        Insert: {
          id?: string;
          owner_id?: string;
          dex_id: string;
          dex_set_name?: string | null;
          dex_series?: string | null;
          dex_number?: string | null;
          dex_name?: string | null;
          dex_variant_raw?: string;
          quantity?: number;
          locale?: string | null;
          reason: string;
          status?: string;
          first_seen_sync?: string;
          last_retry_sync?: string | null;
          retry_count?: number;
          manual_match_id?: string | null;
        };
        Update: {
          id?: string;
          owner_id?: string;
          dex_id?: string;
          dex_set_name?: string | null;
          dex_series?: string | null;
          dex_number?: string | null;
          dex_name?: string | null;
          dex_variant_raw?: string;
          quantity?: number;
          locale?: string | null;
          reason?: string;
          status?: string;
          first_seen_sync?: string;
          last_retry_sync?: string | null;
          retry_count?: number;
          manual_match_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "unresolved_entry_manual_match_id_fkey";
            columns: ["manual_match_id"];
            referencedRelation: "catalog_card";
            referencedColumns: ["tcgdex_id"];
          },
        ];
      };
      set_alias: {
        Row: {
          locale: string;
          dex_code: string;
          tcgdex_set_id: string;
          source: string;
          created_at: string;
        };
        Insert: {
          locale: string;
          dex_code: string;
          tcgdex_set_id: string;
          source?: string;
          created_at?: string;
        };
        Update: {
          locale?: string;
          dex_code?: string;
          tcgdex_set_id?: string;
          source?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      last_sync_snapshot: {
        Row: { id: string; owner_id: string; snapshot: Json; created_at: string };
        Insert: { id?: string; owner_id?: string; snapshot: Json; created_at?: string };
        Update: { id?: string; owner_id?: string; snapshot?: Json; created_at?: string };
        Relationships: [];
      };
    };
    Views: {
      binder_section: {
        Row: {
          binder_id: string | null;
          half: string | null;
          capacity: number | null;
          shelved_count: number | null;
          block_pockets: number | null;
          open_placeholders: number | null;
          free_pockets: number | null;
        };
        Relationships: [];
      };
    };
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
