<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * appointments.cancellation_reason already exists — this brings the same
     * column to the other booking tables so every cancel path can record why.
     */
    public function up(): void
    {
        foreach (['service_requests', 'boardings', 'groomings'] as $table) {
            if (!Schema::hasTable($table) || Schema::hasColumn($table, 'cancellation_reason')) {
                continue;
            }
            Schema::table($table, function (Blueprint $blueprint) {
                $blueprint->string('cancellation_reason', 500)->nullable()->after('rejection_reason');
            });
        }
    }

    public function down(): void
    {
        foreach (['service_requests', 'boardings', 'groomings'] as $table) {
            if (!Schema::hasTable($table) || !Schema::hasColumn($table, 'cancellation_reason')) {
                continue;
            }
            Schema::table($table, function (Blueprint $blueprint) {
                $blueprint->dropColumn('cancellation_reason');
            });
        }
    }
};
