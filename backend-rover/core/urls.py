"""
URL configuration for core project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path
from rover.views import upload_frame, video_feed, telemetry, toggle_record, single_frame, control_rover, get_logs, voice_control

urlpatterns = [
    path('admin/', admin.site.urls),
    path('upload_frame/', upload_frame, name='upload_frame'),
    path('video_feed/', video_feed, name='video_feed'),
    path('telemetry/', telemetry, name='telemetry'),
    path('toggle_record/', toggle_record, name='toggle_record'),
    path('single_frame/', single_frame, name='single_frame'),
    path('control_rover/', control_rover, name='control_rover'),
    path('logs/', get_logs, name='get_logs'),
    path('voice_control/', voice_control, name='voice_control'),
]
