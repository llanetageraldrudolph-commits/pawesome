<?php

namespace App\Providers;

use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;
use Symfony\Component\Mailer\Bridge\Brevo\Transport\BrevoTransportFactory;
use Symfony\Component\Mailer\Transport\Dsn;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Behind TLS-terminating proxies (Railway/Render), url()/asset() must
        // emit https:// or browsers block generated links as mixed content.
        URL::forceHttps($this->app->isProduction());

        // Railway trial plans block outbound SMTP ports, so transactional
        // mail goes over Brevo's HTTPS API instead. Laravel has no native
        // 'brevo' transport, so bridge the Symfony Brevo mailer.
        Mail::extend('brevo', function (array $config) {
            return (new BrevoTransportFactory)->create(new Dsn(
                'brevo+api',
                $config['domain'] ?? 'default',
                $config['key'] ?? '',
            ));
        });
    }
}
